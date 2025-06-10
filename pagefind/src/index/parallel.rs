use dashmap::DashMap;
use rayon::prelude::*;
use std::sync::Arc;
use anyhow::Result;

use crate::{
    fossick::{FossickedData, FossickedWord},
    index::{
        index_filter::PackedValue,
        index_metadata::{MetaIndex, MetaSort},
        index_words::{PackedPage, PackedWord},
        IntermediaryPageData, PagefindIndexes,
    },
    utils::full_hash,
    SearchOptions,
};

/// Build indexes in parallel for improved performance
pub async fn build_indexes_parallel(
    mut pages: Vec<FossickedData>,
    language: String,
    options: &SearchOptions,
) -> Result<PagefindIndexes> {
    let mut meta = MetaIndex {
        version: options.version.into(),
        pages: Vec::new(),
        index_chunks: Vec::new(),
        filters: Vec::new(),
        sorts: Vec::new(),
    };

    // Assign page numbers
    pages.par_iter_mut().enumerate().for_each(|(page_number, page)| {
        page.fragment.page_number = page_number;
    });

    // Get all possible sort keys
    let mut sorts: Vec<_> = pages
        .par_iter()
        .flat_map(|page| page.sort.keys().cloned())
        .collect();
    sorts.sort_unstable();
    sorts.dedup();

    // Process sorts (this part remains sequential as it's fast)
    process_sorts(&mut meta, &pages, &sorts, options);

    // Use DashMap for thread-safe concurrent access
    let word_map: Arc<DashMap<String, Vec<PackedPage>>> = Arc::new(DashMap::new());
    let filter_map: Arc<DashMap<String, DashMap<String, Vec<usize>>>> = Arc::new(DashMap::new());
    let fragment_data: Arc<DashMap<usize, IntermediaryPageData>> = Arc::new(DashMap::new());

    // Process pages in parallel
    pages.par_iter().for_each(|page| {
        process_page_parallel(
            page,
            Arc::clone(&word_map),
            Arc::clone(&filter_map),
            Arc::clone(&fragment_data),
            &language,
        );
    });

    // Convert DashMaps to regular HashMaps
    let mut word_indexes = std::collections::HashMap::new();
    for entry in word_map.iter() {
        let word = entry.key().clone();
        let mut pages = entry.value().clone();
        
        // Sort pages by page number for consistent output
        pages.sort_unstable_by_key(|p| p.page_number);
        
        word_indexes.insert(
            word.clone(),
            PackedWord { word, pages },
        );
    }

    // Build filter indexes
    let mut filter_indexes = std::collections::HashMap::new();
    for entry in filter_map.iter() {
        let filter = entry.key().clone();
        let mut values = std::collections::HashMap::new();
        
        for value_entry in entry.value().iter() {
            let mut pages = value_entry.value().clone();
            pages.sort_unstable();
            values.insert(value_entry.key().clone(), pages);
        }
        
        filter_indexes.insert(filter, values);
    }

    // Collect fragments
    let mut fragments: Vec<_> = fragment_data
        .iter()
        .map(|entry| (*entry.key(), entry.value().clone()))
        .collect();
    fragments.sort_unstable_by_key(|(num, _)| *num);

    // Calculate word count
    let word_count = word_indexes.values().map(|w| w.pages.len()).sum();

    Ok(PagefindIndexes {
        word_indexes: serialize_word_indexes(word_indexes)?,
        filter_indexes: serialize_filter_indexes(filter_indexes)?,
        meta_index: serialize_meta_index(meta)?,
        fragments: fragments.into_iter().map(|(_, data)| (data.full_hash, data.encoded_data)).collect(),
        sorts: sorts,
        language,
        word_count,
    })
}

fn process_page_parallel(
    page: &FossickedData,
    word_map: Arc<DashMap<String, Vec<PackedPage>>>,
    filter_map: Arc<DashMap<String, DashMap<String, Vec<usize>>>>,
    fragment_data: Arc<DashMap<usize, IntermediaryPageData>>,
    language: &str,
) {
    // Process words
    for (word, mut positions) in page.word_data.clone() {
        positions.sort_by_cached_key(|p| if p.weight == 25 { 0 } else { p.weight });

        let mut current_weight = 25;
        let mut weighted_positions = Vec::with_capacity(positions.len());
        
        positions.into_iter().for_each(|FossickedWord { position, weight }| {
            if weight != current_weight {
                weighted_positions.extend([(weight as i32) * -1 - 1, position as i32]);
                current_weight = weight;
            } else {
                weighted_positions.push(position as i32)
            }
        });

        let packed_page = PackedPage {
            page_number: page.fragment.page_number,
            locs: weighted_positions,
        };

        word_map
            .entry(word)
            .and_modify(|pages| pages.push(packed_page.clone()))
            .or_insert_with(|| vec![packed_page]);
    }

    // Process filters
    for (filter, values) in &page.fragment.data.filters {
        let filter_entry = filter_map.entry(filter.clone()).or_insert_with(DashMap::new);
        
        for value in values {
            filter_entry
                .entry(value.clone())
                .and_modify(|pages| pages.push(page.fragment.page_number))
                .or_insert_with(|| vec![page.fragment.page_number]);
        }
    }

    // Store fragment data
    let encoded_data = serde_json::to_string(&page.fragment.data).unwrap();
    let encoded_page = IntermediaryPageData {
        full_hash: format!("{}_{}", language, full_hash(encoded_data.as_bytes())),
        word_count: page.fragment.data.word_count,
        page_number: page.fragment.page_number,
        encoded_data,
    };

    fragment_data.insert(page.fragment.page_number, encoded_page);
}

fn process_sorts(
    meta: &mut MetaIndex,
    pages: &[FossickedData],
    sorts: &[String],
    options: &SearchOptions,
) {
    use super::{parse_int_sort, parse_float_sort, SortType};
    use std::collections::HashMap;

    // Determine sort types
    let mut sort_types: HashMap<String, SortType> = HashMap::new();
    for sort in sorts.iter() {
        let mut sort_values = pages.iter().flat_map(|page| page.sort.get(sort));
        sort_types.insert(
            sort.clone(),
            if sort_values.all(|v| parse_int_sort(v).is_some() || parse_float_sort(v).is_some()) {
                SortType::Number
            } else {
                SortType::String
            },
        );
    }

    // Process each sort
    for (sort_key, sort_type) in sort_types {
        let mut page_values: Vec<_> = pages
            .iter()
            .flat_map(|page| {
                page.sort
                    .get(&sort_key)
                    .map(|v| (v, page.fragment.page_number))
            })
            .collect();
            
        options.logger.v_info(format!(
            "Prebuilding sort order for {sort_key}, processed as type: {sort_type:#?}"
        ));
        
        match sort_type {
            SortType::String => page_values.sort_by_key(|p| p.0),
            SortType::Number => page_values.sort_by(|p1, p2| {
                let p1 = parse_int_sort(p1.0)
                    .map(|i| i as f32)
                    .unwrap_or_else(|| parse_float_sort(p1.0).unwrap_or_default());
                let p2 = parse_int_sort(p2.0)
                    .map(|i| i as f32)
                    .unwrap_or_else(|| parse_float_sort(p2.0).unwrap_or_default());

                p1.total_cmp(&p2)
            }),
        }
        
        meta.sorts.push(MetaSort {
            sort: sort_key,
            pages: page_values.into_iter().map(|p| p.1).collect(),
        });
    }
}

// Placeholder functions for serialization
fn serialize_word_indexes(indexes: std::collections::HashMap<String, PackedWord>) -> Result<std::collections::HashMap<String, Vec<u8>>> {
    // Implementation would serialize each word index
    todo!("Implement word index serialization")
}

fn serialize_filter_indexes(indexes: std::collections::HashMap<String, std::collections::HashMap<String, Vec<usize>>>) -> Result<std::collections::HashMap<String, Vec<u8>>> {
    // Implementation would serialize each filter index
    todo!("Implement filter index serialization")
}

fn serialize_meta_index(meta: MetaIndex) -> Result<(String, Vec<u8>)> {
    // Implementation would serialize the meta index
    todo!("Implement meta index serialization")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parallel_processing() {
        // Test would verify parallel processing produces same results as sequential
    }
}