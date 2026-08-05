export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ChallengeKind =
  | 'cloudflare-js-challenge'
  | 'cloudflare-turnstile'
  | 'akamai'
  | 'perimeterx'
  | 'datadome'
  | 'generic-interstitial'
  | 'unknown-empty'
  | 'unknown';

/** How likely a challenge is to clear on its own for a real device just waiting. */
export type Clearable = 'likely' | 'maybe' | 'unlikely';

export interface PageInfo {
  url: string;
  status: number;
  title: string;
  textLength: number;
  blocked: boolean;
  challenge?: ChallengeKind;
  clearable?: Clearable;
}

export interface ContentWait extends PageInfo {
  settled: boolean;
  stalled: boolean;
  excerpt?: string;
  recommendation?: string;
}

export interface PageTextResult {
  text: string;
  truncated: boolean;
  textLength: number;
}

export interface CaptureResult {
  buffer: Uint8Array | undefined;
  clip: Clip;
  width?: number;
  height?: number;
}

export interface ReadResult extends PageInfo {
  settled: boolean;
  stalled?: boolean;
  excerpt?: string;
  text: string;
  truncated: boolean;
  screenshot?: Uint8Array;
}

export interface CompareResult extends PageInfo {
  country: string;
  excerpt: string;
  extracted?: string | null;
  screenshot?: Uint8Array;
}

export type EffectResult = 'navigation' | 'dom-change' | 'none' | 'unknown';
