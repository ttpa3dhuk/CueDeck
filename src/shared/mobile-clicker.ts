export interface ClickerGrant { id: string; name: string; key: string; presentations: string[] | null }
export interface ClickerAccess { online: boolean; publicUrl: string; grants: ClickerGrant[]; guestOpen?: boolean; guestPresentations?: string[] | null }
export interface ClickerClient { id: string; grantId: string; name: string; lastSeen: number; blocked: boolean; direct?: boolean; presentations?: string[] | null; pending?: boolean; operatorBlocked?: boolean }
export interface MobileClickerStatus {
  enabled: boolean; urls: string[]; qr: string | null; error: string | null
  online?: boolean; publicUrl?: string; target?: string
  guestOpen?: boolean; guestPresentations?: string[] | null
  cloudpub?: { state: 'idle' | 'connecting' | 'connected' | 'error'; message: string | null }
  grants?: Array<Omit<ClickerGrant, 'key'>>; clients?: ClickerClient[]
}
export interface ClickerInvitation { url: string; qr: string }
export interface MobileClickerSnapshot { presentationId?: string | null; current: number; total: number; remaining: number; canNavigate: boolean; timer: { text: string; color: string } }
