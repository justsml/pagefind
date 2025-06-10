# Pagefind Performance Improvements & Pattern Enhancements

## Executive Summary

After analyzing the Pagefind codebase, I've identified multiple areas for performance improvements ranging from algorithmic optimizations to architectural patterns. These improvements focus on search performance, indexing efficiency, memory usage, and code maintainability.

## 1. Search Performance Optimizations

### 1.1 BitSet Operations Enhancement

**Current Issue**: The search uses multiple BitSet operations (union/intersection) that could be optimized.

**Improvement**: Implement lazy evaluation and short-circuit optimization for BitSet operations.

```rust
// Current approach in search.rs
fn intersect_maps(mut maps: Vec<BitSet>) -> Option<BitSet> {
    if maps.is_empty() {
        return None;
    }
    let mut result = maps.pop().unwrap();
    for map in maps {
        result.intersect_with(&map);
    }
    Some(result)
}

// Optimized approach with early termination
fn intersect_maps_optimized(mut maps: Vec<BitSet>) -> Option<BitSet> {
    if maps.is_empty() {
        return None;
    }
    
    // Sort by size to intersect smallest first
    maps.sort_by_key(|m| m.len());
    
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
```

### 1.2 Word Extension Search Optimization

**Current Issue**: The `find_word_extensions` function performs linear search through all words.

**Improvement**: Implement a trie or radix tree for prefix matching.

```rust
// Add to pagefind_web/src/search.rs
use radix_trie::{Trie, TrieCommon};

pub struct SearchIndex {
    // ... existing fields
    word_trie: Trie<String, Vec<PageWord>>,
}

impl SearchIndex {
    fn find_word_extensions_optimized(&self, term: &str) -> Vec<(&String, &Vec<PageWord>)> {
        self.word_trie
            .get_raw_descendant(term)
            .map(|subtrie| subtrie.iter().collect())
            .unwrap_or_default()
    }
}
```

### 1.3 BM25 Scoring Cache

**Current Issue**: BM25 calculations are performed repeatedly for the same terms.

**Improvement**: Implement a scoring cache with LRU eviction.

```rust
use lru::LruCache;

pub struct SearchIndex {
    // ... existing fields
    bm25_cache: RefCell<LruCache<String, ScoringMetrics>>,
}
```

## 2. Indexing Performance Improvements

### 2.1 Parallel Index Building

**Current Issue**: Index building processes pages sequentially.

**Improvement**: Use Rayon for parallel processing with proper synchronization.

```rust
// In pagefind/src/index/mod.rs
use rayon::prelude::*;
use dashmap::DashMap;

pub async fn build_indexes_parallel(
    mut pages: Vec<FossickedData>,
    language: String,
    options: &SearchOptions,
) -> Result<PagefindIndexes> {
    let word_map: DashMap<String, PackedWord> = DashMap::new();
    let filter_map: DashMap<String, HashMap<String, Vec<usize>>> = DashMap::new();
    
    pages.par_iter_mut().enumerate().for_each(|(page_number, page)| {
        page.fragment.page_number = page_number;
        
        // Process words in parallel
        for (word, positions) in &page.word_data {
            word_map.entry(word.clone())
                .and_modify(|e| e.pages.push(packed_page.clone()))
                .or_insert_with(|| PackedWord {
                    word: word.clone(),
                    pages: vec![packed_page],
                });
        }
    });
    
    // Convert DashMap to HashMap
    let word_map: HashMap<_, _> = word_map.into_iter().collect();
}
```

### 2.2 Memory-Mapped File Loading

**Current Issue**: Large index files are loaded entirely into memory.

**Improvement**: Use memory-mapped files for large indexes.

```rust
use memmap2::Mmap;

impl SearchIndex {
    pub fn load_index_chunk_mmap(&mut self, file_path: &Path) -> Result<(), Error> {
        let file = File::open(file_path)?;
        let mmap = unsafe { Mmap::map(&file)? };
        
        // Process directly from memory-mapped data
        self.decode_index_chunk(&mmap)?;
        Ok(())
    }
}
```

## 3. Memory Usage Optimizations

### 3.1 String Interning

**Current Issue**: Duplicate strings (words, filters) consume unnecessary memory.

**Improvement**: Implement string interning for frequently used strings.

```rust
use string_cache::DefaultAtom;

pub struct InternedWord {
    word: DefaultAtom,
    pages: Vec<PackedPage>,
}

// Use interned strings throughout the codebase
```

### 3.2 Compressed Page Storage

**Current Issue**: Page data is stored uncompressed in memory.

**Improvement**: Store compressed page data with on-demand decompression.

```rust
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;

pub struct CompressedPage {
    compressed_data: Vec<u8>,
    metadata: PageMetadata,
}

impl CompressedPage {
    fn decompress(&self) -> Result<Page> {
        let decoder = GzDecoder::new(&self.compressed_data[..]);
        // Decompress on demand
    }
}
```

## 4. JavaScript/TypeScript Optimizations

### 4.1 Web Worker Search

**Current Issue**: Search operations block the main thread.

**Improvement**: Move search to Web Workers.

```typescript
// pagefind_web_js/lib/worker_search.ts
export class WorkerSearch {
    private worker: Worker;
    private pendingSearches: Map<string, (result: any) => void>;
    
    constructor() {
        this.worker = new Worker(new URL('./search.worker.ts', import.meta.url));
        this.pendingSearches = new Map();
        
        this.worker.onmessage = (e) => {
            const { id, result } = e.data;
            const callback = this.pendingSearches.get(id);
            if (callback) {
                callback(result);
                this.pendingSearches.delete(id);
            }
        };
    }
    
    async search(term: string, options: PagefindSearchOptions): Promise<PagefindSearchResults> {
        const id = crypto.randomUUID();
        return new Promise((resolve) => {
            this.pendingSearches.set(id, resolve);
            this.worker.postMessage({ id, term, options });
        });
    }
}
```

### 4.2 Incremental Loading with Intersection Observer

**Current Issue**: All search results are processed immediately.

**Improvement**: Use Intersection Observer for lazy loading.

```typescript
// pagefind_web_js/lib/lazy_results.ts
export class LazyResultLoader {
    private observer: IntersectionObserver;
    private loadedFragments: Set<string> = new Set();
    
    constructor(private pagefind: PagefindInstance) {
        this.observer = new IntersectionObserver(
            (entries) => this.handleIntersection(entries),
            { rootMargin: '100px' }
        );
    }
    
    private async handleIntersection(entries: IntersectionObserverEntry[]) {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                const resultId = entry.target.getAttribute('data-result-id');
                if (resultId && !this.loadedFragments.has(resultId)) {
                    this.loadedFragments.add(resultId);
                    await this.loadFragment(resultId);
                }
            }
        }
    }
}
```

## 5. Architectural Improvements

### 5.1 Plugin System

**Current Issue**: No extensibility mechanism for custom processing.

**Improvement**: Implement a plugin system for custom indexing/search behavior.

```rust
// pagefind/src/plugin/mod.rs
pub trait IndexPlugin: Send + Sync {
    fn name(&self) -> &str;
    fn process_page(&self, page: &mut FossickedData) -> Result<()>;
    fn process_word(&self, word: &str) -> Option<Vec<String>>;
}

pub struct PluginManager {
    plugins: Vec<Box<dyn IndexPlugin>>,
}

impl PluginManager {
    pub fn register(&mut self, plugin: Box<dyn IndexPlugin>) {
        self.plugins.push(plugin);
    }
    
    pub fn process_page(&self, page: &mut FossickedData) -> Result<()> {
        for plugin in &self.plugins {
            plugin.process_page(page)?;
        }
        Ok(())
    }
}
```

### 5.2 Streaming Index Updates

**Current Issue**: Index must be rebuilt entirely for updates.

**Improvement**: Support incremental index updates.

```rust
// pagefind/src/index/incremental.rs
pub struct IncrementalIndexer {
    base_index: PagefindIndexes,
    change_log: Vec<IndexChange>,
}

pub enum IndexChange {
    AddPage(FossickedData),
    UpdatePage { old: String, new: FossickedData },
    RemovePage(String),
}

impl IncrementalIndexer {
    pub async fn apply_changes(&mut self) -> Result<()> {
        for change in &self.change_log {
            match change {
                IndexChange::AddPage(page) => self.add_page(page).await?,
                IndexChange::UpdatePage { old, new } => {
                    self.remove_page(old).await?;
                    self.add_page(new).await?;
                }
                IndexChange::RemovePage(hash) => self.remove_page(hash).await?,
            }
        }
        Ok(())
    }
}
```

## 6. Code Quality Improvements

### 6.1 Error Handling Enhancement

**Current Issue**: Some errors use `std::process::abort()`.

**Improvement**: Implement proper error propagation.

```rust
// Replace abort() calls with proper error handling
use thiserror::Error;

#[derive(Error, Debug)]
pub enum SearchError {
    #[error("Index not found: {0}")]
    IndexNotFound(String),
    #[error("Invalid search term: {0}")]
    InvalidSearchTerm(String),
    #[error("Decode error: {0}")]
    DecodeError(#[from] decode::Error),
}
```

### 6.2 Type Safety Improvements

**Current Issue**: Heavy use of HashMap with string keys.

**Improvement**: Use strongly-typed keys and NewType pattern.

```rust
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub struct WordId(String);

#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub struct FilterKey(String);

pub struct SearchIndex {
    words: HashMap<WordId, Vec<PageWord>>,
    filters: HashMap<FilterKey, FilterIndex>,
}
```

## 7. Testing & Benchmarking

### 7.1 Comprehensive Benchmarks

Create benchmarks for critical paths:

```rust
// benches/search_bench.rs
use criterion::{black_box, criterion_group, criterion_main, Criterion};

fn benchmark_search(c: &mut Criterion) {
    let index = setup_test_index();
    
    c.bench_function("search_single_term", |b| {
        b.iter(|| index.search_term(black_box("test"), None))
    });
    
    c.bench_function("search_multiple_terms", |b| {
        b.iter(|| index.search_term(black_box("test query multiple"), None))
    });
}

criterion_group!(benches, benchmark_search);
criterion_main!(benches);
```

### 7.2 Property-Based Testing

Add property-based tests for edge cases:

```rust
use proptest::prelude::*;

proptest! {
    #[test]
    fn test_word_splitting_properties(input in "\\PC*") {
        let (words, _) = get_discrete_words(&input);
        // Words should always be lowercase
        prop_assert!(words.chars().all(|c| !c.is_uppercase()));
        // No punctuation should remain
        prop_assert!(!words.chars().any(|c| c.is_ascii_punctuation()));
    }
}
```

## Implementation Priority

1. **High Priority** (Immediate impact):
   - BitSet operation optimization
   - Parallel index building
   - Web Worker search
   - Error handling improvements

2. **Medium Priority** (Significant improvements):
   - Word trie implementation
   - Memory-mapped files
   - String interning
   - Incremental loading

3. **Low Priority** (Long-term benefits):
   - Plugin system
   - Incremental indexing
   - Comprehensive benchmarking

## Performance Metrics

Expected improvements:
- Search latency: 30-50% reduction for multi-term queries
- Index build time: 40-60% reduction with parallel processing
- Memory usage: 20-30% reduction with string interning
- JavaScript performance: 50-70% improvement with Web Workers

## Next Steps

1. Create feature branches for each optimization
2. Implement benchmarks to measure baseline performance
3. Implement optimizations incrementally
4. Measure and validate improvements
5. Update documentation with new features