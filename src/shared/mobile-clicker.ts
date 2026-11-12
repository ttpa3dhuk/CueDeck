export interface MobileClickerStatus { enabled: boolean; urls: string[]; qr: string | null; error: string | null }
export interface MobileClickerSnapshot { current: number; total: number; remaining: number; canNavigate: boolean; timer: { text: string; color: string } }
