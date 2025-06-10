import type { PagefindInstance } from "./coupled_search";

interface WorkerMessage {
    id: string;
    type: 'init' | 'search' | 'filter' | 'preload';
    payload: any;
}

interface WorkerResponse {
    id: string;
    type: 'result' | 'error';
    result?: any;
    error?: string;
}

/**
 * WorkerPagefindInstance wraps PagefindInstance to offload search operations to a Web Worker
 * This prevents blocking the main thread during intensive search operations
 */
export class WorkerPagefindInstance {
    private worker: Worker | null = null;
    private pendingRequests: Map<string, {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
    }> = new Map();
    private workerReady: Promise<void>;
    private workerReadyResolve!: () => void;
    private basePath: string;
    private fallbackInstance?: PagefindInstance;
    
    constructor(private options: PagefindIndexOptions = {}) {
        this.basePath = options.basePath || "/pagefind/";
        this.workerReady = new Promise((resolve) => {
            this.workerReadyResolve = resolve;
        });
        
        this.initWorker();
    }
    
    private initWorker() {
        try {
            // Try to create a worker
            this.worker = new Worker(
                new URL('./search.worker.ts', import.meta.url),
                { type: 'module' }
            );
            
            this.worker.addEventListener('message', (event: MessageEvent) => {
                this.handleWorkerMessage(event.data);
            });
            
            this.worker.addEventListener('error', (error) => {
                console.error('Worker error:', error);
                this.fallbackToMainThread();
            });
            
        } catch (error) {
            console.warn('Failed to create Web Worker, falling back to main thread:', error);
            this.fallbackToMainThread();
        }
    }
    
    private handleWorkerMessage(message: WorkerResponse | { type: 'ready' }) {
        if (message.type === 'ready') {
            this.workerReadyResolve();
            return;
        }
        
        if ('id' in message) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                this.pendingRequests.delete(message.id);
                
                if (message.type === 'error') {
                    pending.reject(new Error(message.error || 'Unknown worker error'));
                } else {
                    pending.resolve(message.result);
                }
            }
        }
    }
    
    private async sendToWorker<T>(type: string, payload: any): Promise<T> {
        if (!this.worker) {
            throw new Error('Worker not available');
        }
        
        await this.workerReady;
        
        const id = crypto.randomUUID();
        
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            
            const message: WorkerMessage = { id, type: type as any, payload };
            this.worker!.postMessage(message);
            
            // Timeout after 30 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('Worker request timeout'));
                }
            }, 30000);
        });
    }
    
    private async fallbackToMainThread() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        
        // Lazy load the fallback instance
        if (!this.fallbackInstance) {
            const { PagefindInstance } = await import('./coupled_search');
            this.fallbackInstance = new PagefindInstance(this.options);
        }
        this.workerReadyResolve();
    }
    
    async init(language?: string): Promise<void> {
        await this.workerReady;
        
        if (this.fallbackInstance) {
            // @ts-ignore - init method exists but may not be in types
            return this.fallbackInstance.init?.(language);
        }
        
        // Load meta and initialize worker
        const metaResponse = await fetch(`${this.basePath}pagefind.${language || 'en'}.pf_meta`);
        const metaBytes = new Uint8Array(await metaResponse.arrayBuffer());
        
        await this.sendToWorker('init', { metaBytes });
    }
    
    async search(query: string, options?: PagefindSearchOptions): Promise<PagefindSearchResults> {
        await this.workerReady;
        
        if (this.fallbackInstance) {
            const result = await this.fallbackInstance.search(query, options);
            return result || { results: [], unfilteredResultCount: 0, filters: {}, totalFilters: {}, timings: { preload: 0, search: 0, total: 0 } };
        }
        
        const startTime = performance.now();
        
        try {
            const result = await this.sendToWorker<PagefindSearchResults>('search', {
                query,
                options: options || {},
                basePath: this.basePath
            });
            
            // Add timing information
            const endTime = performance.now();
            if (result.timings) {
                result.timings.total = endTime - startTime;
            }
            
            return result;
            
        } catch (error) {
            console.error('Worker search failed, falling back to main thread:', error);
            await this.fallbackToMainThread();
            
            // Retry on main thread - fallbackInstance should now be initialized
            const result = await this.fallbackInstance!.search(query, options);
            return result || { results: [], unfilteredResultCount: 0, filters: {}, totalFilters: {}, timings: { preload: 0, search: 0, total: 0 } };
        }
    }
    
    async filters(): Promise<PagefindFilterCounts> {
        await this.workerReady;
        
        if (this.fallbackInstance) {
            return this.fallbackInstance.filters();
        }
        
        return this.sendToWorker<PagefindFilterCounts>('filter', {});
    }
    
    async preload(query: string, options?: PagefindSearchOptions): Promise<void> {
        await this.workerReady;
        
        if (this.fallbackInstance) {
            return this.fallbackInstance.preload(query, options);
        }
        
        // Get required indexes
        const searchResult = await this.search(query, { ...options, preload: true });
        
        // Preload is handled by the worker during search
        return;
    }
    
    destroy() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        
        // Clear pending requests
        for (const [id, { reject }] of this.pendingRequests) {
            reject(new Error('Worker destroyed'));
        }
        this.pendingRequests.clear();
    }
}

/**
 * Factory function to create a Pagefind instance that automatically uses Web Workers when available
 */
export async function createPagefindInstance(options?: PagefindIndexOptions): Promise<WorkerPagefindInstance | PagefindInstance> {
    // Check if we're in a browser environment that supports Workers
    if (typeof Worker !== 'undefined' && typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return new WorkerPagefindInstance(options);
    }
    
    // Fall back to regular instance
    console.info('Web Workers not available, using main thread for search');
    const { PagefindInstance } = await import('./coupled_search');
    return new PagefindInstance(options);
}

// Performance monitoring utilities
export class SearchPerformanceMonitor {
    private metrics: Array<{
        query: string;
        duration: number;
        resultCount: number;
        timestamp: number;
        workerUsed: boolean;
    }> = [];
    
    recordSearch(query: string, duration: number, resultCount: number, workerUsed: boolean) {
        this.metrics.push({
            query,
            duration,
            resultCount,
            timestamp: Date.now(),
            workerUsed
        });
        
        // Keep only last 100 searches
        if (this.metrics.length > 100) {
            this.metrics.shift();
        }
    }
    
    getAverageSearchTime(): number {
        if (this.metrics.length === 0) return 0;
        
        const sum = this.metrics.reduce((acc, m) => acc + m.duration, 0);
        return sum / this.metrics.length;
    }
    
    getWorkerVsMainThreadComparison(): {
        worker: { count: number; avgTime: number };
        mainThread: { count: number; avgTime: number };
    } {
        const workerMetrics = this.metrics.filter(m => m.workerUsed);
        const mainThreadMetrics = this.metrics.filter(m => !m.workerUsed);
        
        return {
            worker: {
                count: workerMetrics.length,
                avgTime: workerMetrics.length > 0
                    ? workerMetrics.reduce((acc, m) => acc + m.duration, 0) / workerMetrics.length
                    : 0
            },
            mainThread: {
                count: mainThreadMetrics.length,
                avgTime: mainThreadMetrics.length > 0
                    ? mainThreadMetrics.reduce((acc, m) => acc + m.duration, 0) / mainThreadMetrics.length
                    : 0
            }
        };
    }
    
    exportMetrics(): string {
        return JSON.stringify(this.metrics, null, 2);
    }
}

// Global performance monitor instance
export const searchPerformance = new SearchPerformanceMonitor();