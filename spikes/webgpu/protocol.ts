export type WebGpuSpikeCommand =
  | { readonly kind: 'probe' }
  | { readonly kind: 'run-p0' }
  | { readonly kind: 'run-p1' }
  | { readonly kind: 'run-p2' };

export interface WebGpuSpikeRequest {
  readonly command: WebGpuSpikeCommand;
  readonly id: number;
}

export type WebGpuSpikeResponse =
  | { readonly error: string; readonly id: number }
  | { readonly id: number; readonly result: unknown };
