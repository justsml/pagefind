use bit_set::BitSet;
use std::cmp::Ordering;

/// Optimized intersection of multiple BitSets with early termination
pub fn intersect_maps_optimized(mut maps: Vec<BitSet>) -> Option<BitSet> {
    if maps.is_empty() {
        return None;
    }
    
    // Sort by size to intersect smallest first (reduces operations)
    maps.sort_unstable_by_key(|m| m.len());
    
    let mut result = maps.pop().unwrap();
    
    for map in maps {
        result.intersect_with(&map);
        
        // Early termination if result is empty
        if result.is_empty() {
            return Some(result);
        }
    }
    
    Some(result)
}

/// Optimized union of multiple BitSets
pub fn union_maps_optimized(mut maps: Vec<BitSet>) -> Option<BitSet> {
    if maps.is_empty() {
        return None;
    }
    
    // For union, start with largest to minimize resizing
    maps.sort_unstable_by_key(|m| std::cmp::Reverse(m.len()));
    
    let mut result = maps.pop().unwrap();
    
    for map in maps {
        result.union_with(&map);
    }
    
    Some(result)
}

/// Batch intersection with progress tracking for large operations
pub fn intersect_maps_with_progress<F>(
    mut maps: Vec<BitSet>,
    mut progress_callback: F,
) -> Option<BitSet>
where
    F: FnMut(usize, usize),
{
    if maps.is_empty() {
        return None;
    }
    
    maps.sort_unstable_by_key(|m| m.len());
    let total = maps.len();
    
    let mut result = maps.pop().unwrap();
    
    for (i, map) in maps.into_iter().enumerate() {
        result.intersect_with(&map);
        progress_callback(i + 1, total);
        
        if result.is_empty() {
            return Some(result);
        }
    }
    
    Some(result)
}

/// Parallel BitSet operations using rayon
#[cfg(feature = "parallel")]
pub mod parallel {
    use super::*;
    use rayon::prelude::*;
    
    /// Parallel intersection for very large BitSet collections
    pub fn intersect_maps_parallel(maps: Vec<BitSet>) -> Option<BitSet> {
        if maps.is_empty() {
            return None;
        }
        
        // Use parallel reduction for large collections
        if maps.len() > 8 {
            maps.into_par_iter()
                .reduce(
                    || BitSet::new(),
                    |mut a, b| {
                        a.intersect_with(&b);
                        a
                    },
                )
                .into()
        } else {
            // Fall back to sequential for small collections
            intersect_maps_optimized(maps)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_intersect_empty() {
        assert!(intersect_maps_optimized(vec![]).is_none());
    }
    
    #[test]
    fn test_intersect_single() {
        let mut set = BitSet::new();
        set.insert(1);
        set.insert(2);
        
        let result = intersect_maps_optimized(vec![set.clone()]);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), set);
    }
    
    #[test]
    fn test_intersect_multiple() {
        let mut set1 = BitSet::new();
        set1.insert(1);
        set1.insert(2);
        set1.insert(3);
        
        let mut set2 = BitSet::new();
        set2.insert(2);
        set2.insert(3);
        set2.insert(4);
        
        let mut expected = BitSet::new();
        expected.insert(2);
        expected.insert(3);
        
        let result = intersect_maps_optimized(vec![set1, set2]);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), expected);
    }
    
    #[test]
    fn test_early_termination() {
        let mut set1 = BitSet::new();
        set1.insert(1);
        
        let mut set2 = BitSet::new();
        set2.insert(2);
        
        // These sets have no intersection
        let result = intersect_maps_optimized(vec![set1, set2]);
        assert!(result.is_some());
        assert!(result.unwrap().is_empty());
    }
}