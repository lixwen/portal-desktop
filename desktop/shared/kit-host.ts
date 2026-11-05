/** Public receipt only: no authentication material or fabricated readiness. */
export interface HostEnrollment { target_id: string; revision: number; generation: number; lease_expires_at: string }
