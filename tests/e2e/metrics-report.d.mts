export function distribution(values:number[]): {n:number;p50:number;p95:number;min:number;max:number}|null;
export const BENCHMARK_SUITE_FILES: readonly string[];
export function benchmarkSuiteHash(root:string):Promise<string>;
export function summarize(run:any):any;
export function compareRuns(before:any,after:any):any;
export function renderMarkdown(report:any):string;
export function renderHtml(report:any):string;
export function writeReports(directory:string,report:any):Promise<void>;
