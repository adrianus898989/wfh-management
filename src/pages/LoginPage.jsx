// Legacy import compatibility only. Every password login must pass through the
// shared admin-login Edge Function so lockout, IP and session checks cannot be
// bypassed by a browser-side Supabase Auth call.
export { default } from './StaffLoginPage'
