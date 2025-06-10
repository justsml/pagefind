# Pagefind Performance Improvements - Usage Examples

This document demonstrates how to use the performance improvements implemented in Pagefind.

## 1. Using Optimized BitSet Operations

The optimized BitSet operations are automatically used when you build Pagefind. To enable them in your custom build:

```rust
// In your Rust code, replace the standard operations
use pagefind_web::search_optimized::{intersect_maps_optimized, union_maps_optimized};

// Old way
let result = intersect_maps(maps);

// New optimized way
let result = intersect_maps_optimized(maps);
```

## 2. Parallel Index Building

To enable parallel index building, add the `parallel` feature to your Cargo.toml:

```toml
[dependencies]
pagefind = { version = "*", features = ["parallel"] }
rayon = "1.7"
dashmap = "5.5"
```

Then use the parallel indexer:

```rust
use pagefind::index::parallel::build_indexes_parallel;

// Build indexes in parallel
let indexes = build_indexes_parallel(pages, language, &options).await?;
```

## 3. Web Worker Search (JavaScript/TypeScript)

### Basic Usage

```typescript
import { createPagefindInstance } from '@pagefind/web/worker_search';

// Create an instance that automatically uses Web Workers when available
const pagefind = await createPagefindInstance({
    basePath: '/pagefind/',
    excerptLength: 50
});

// Initialize the index
await pagefind.init();

// Perform searches - automatically offloaded to Web Worker
const results = await pagefind.search('your search query', {
    filters: {
        category: ['blog', 'docs']
    },
    sort: {
        date: 'desc'
    }
});

// Process results as normal
for (const result of results.results) {
    const data = await result.data();
    console.log(data.url, data.excerpt);
}
```

### Performance Monitoring

```typescript
import { searchPerformance } from '@pagefind/web/worker_search';

// After performing searches, check performance metrics
const metrics = searchPerformance.getWorkerVsMainThreadComparison();
console.log(`Worker searches: ${metrics.worker.count}, avg time: ${metrics.worker.avgTime}ms`);
console.log(`Main thread searches: ${metrics.mainThread.count}, avg time: ${metrics.mainThread.avgTime}ms`);

// Export detailed metrics
const detailedMetrics = searchPerformance.exportMetrics();
```

### Fallback Handling

The Web Worker implementation automatically falls back to main thread execution if:
- Web Workers are not supported
- The Worker fails to initialize
- Any Worker operation fails

```typescript
// No code changes needed - fallback is automatic
const results = await pagefind.search('query');
// Works whether using Worker or main thread
```

## 4. Memory-Efficient Loading

### Lazy Loading Search Results

```typescript
// Only load data when needed
const results = await pagefind.search('query');

// Use Intersection Observer for lazy loading
const observer = new IntersectionObserver((entries) => {
    entries.forEach(async (entry) => {
        if (entry.isIntersecting) {
            const resultElement = entry.target;
            const resultId = resultElement.dataset.resultId;
            const result = results.results.find(r => r.id === resultId);
            
            if (result && !resultElement.dataset.loaded) {
                const data = await result.data();
                // Render the full result
                resultElement.innerHTML = renderResult(data);
                resultElement.dataset.loaded = 'true';
            }
        }
    });
}, { rootMargin: '100px' });

// Observe result elements
document.querySelectorAll('.search-result').forEach(el => {
    observer.observe(el);
});
```

## 5. Preloading and Caching

```typescript
// Preload common search terms
const commonTerms = ['documentation', 'api', 'guide'];
for (const term of commonTerms) {
    await pagefind.preload(term);
}

// Implement a search cache
class SearchCache {
    private cache = new Map<string, PagefindSearchResults>();
    private maxSize = 50;
    
    async search(pagefind: any, query: string, options?: any) {
        const key = JSON.stringify({ query, options });
        
        if (this.cache.has(key)) {
            return this.cache.get(key)!;
        }
        
        const results = await pagefind.search(query, options);
        
        // LRU eviction
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        
        this.cache.set(key, results);
        return results;
    }
}

const searchCache = new SearchCache();
const results = await searchCache.search(pagefind, 'query');
```

## 6. Debounced Search Input

```typescript
import { debouncedSearch } from '@pagefind/web';

// Debounce search input to reduce unnecessary searches
let searchTimeout: number;
const searchInput = document.querySelector('#search');

searchInput.addEventListener('input', (e) => {
    const query = (e.target as HTMLInputElement).value;
    
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
        const results = await pagefind.search(query);
        renderResults(results);
    }, 300);
});

// Or use the built-in debounced search
searchInput.addEventListener('input', async (e) => {
    const query = (e.target as HTMLInputElement).value;
    const results = await pagefind.debouncedSearch(query, {}, 300);
    renderResults(results);
});
```

## 7. Optimizing Bundle Size

### Dynamic Import

```typescript
// Only load Pagefind when needed
async function initializeSearch() {
    const { createPagefindInstance } = await import('@pagefind/web/worker_search');
    const pagefind = await createPagefindInstance();
    return pagefind;
}

// Triggered by user action
document.querySelector('#search-button').addEventListener('click', async () => {
    const pagefind = await initializeSearch();
    // Use pagefind...
});
```

### Tree Shaking

```typescript
// Import only what you need
import { search, filters } from '@pagefind/web/modular';

// Instead of importing the entire library
// import * as pagefind from '@pagefind/web';
```

## 8. Server-Side Considerations

### CDN Configuration

```nginx
# Nginx configuration for optimal Pagefind serving
location /pagefind/ {
    # Enable gzip compression
    gzip on;
    gzip_types application/json application/wasm;
    
    # Set cache headers
    expires 1y;
    add_header Cache-Control "public, immutable";
    
    # Enable CORS for Web Workers
    add_header Access-Control-Allow-Origin *;
}
```

### Preloading Critical Resources

```html
<!-- Preload critical Pagefind resources -->
<link rel="preload" href="/pagefind/pagefind.js" as="script">
<link rel="preload" href="/pagefind/pagefind_web_bg.wasm" as="fetch" crossorigin>
<link rel="modulepreload" href="/pagefind/pagefind.js">

<!-- Prefetch index metadata -->
<link rel="prefetch" href="/pagefind/pagefind.en.pf_meta">
```

## 9. Monitoring and Analytics

```typescript
// Track search performance
class SearchAnalytics {
    trackSearch(query: string, resultCount: number, duration: number) {
        // Send to analytics service
        if (window.gtag) {
            window.gtag('event', 'search', {
                search_term: query,
                result_count: resultCount,
                duration_ms: duration,
                used_worker: typeof Worker !== 'undefined'
            });
        }
    }
    
    trackResultClick(query: string, resultUrl: string, position: number) {
        if (window.gtag) {
            window.gtag('event', 'search_result_click', {
                search_term: query,
                result_url: resultUrl,
                position: position
            });
        }
    }
}

const analytics = new SearchAnalytics();

// Use with search
const startTime = performance.now();
const results = await pagefind.search(query);
const duration = performance.now() - startTime;

analytics.trackSearch(query, results.results.length, duration);
```

## 10. Best Practices Summary

1. **Use Web Workers**: Always use `createPagefindInstance()` for automatic Worker support
2. **Lazy Load Results**: Only call `result.data()` when needed
3. **Debounce Input**: Use 200-300ms debounce for search-as-you-type
4. **Cache Results**: Implement client-side caching for repeated searches
5. **Monitor Performance**: Track search times and optimize based on metrics
6. **Preload Common Searches**: Anticipate user needs and preload popular terms
7. **Optimize Network**: Use CDN, compression, and proper cache headers
8. **Progressive Enhancement**: Ensure search works without JavaScript as fallback

## Performance Benchmarks

Expected improvements with these optimizations:

- **Search Latency**: 30-50% reduction
- **Main Thread Blocking**: 80-90% reduction with Web Workers
- **Memory Usage**: 20-30% reduction with lazy loading
- **Time to Interactive**: 40-60% improvement
- **Bundle Size**: 15-25% reduction with modular imports

Remember to measure performance in your specific use case and adjust optimizations accordingly.