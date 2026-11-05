// The derived state from docs/SPEC.md section 3. This is the only signal-related type
// that downstream modules may see. M1 adds the machine that produces it.
export type DevState = 'off' | 'warming_up' | 'away' | 'talking' | 'available' | 'focused';
