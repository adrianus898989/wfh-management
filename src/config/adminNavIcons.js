// Admin sidebar icons are intentionally code-native so they stay sharp at every
// zoom level and inherit the sidebar's active, hover and high-contrast states.
// Keep this registry keyed by the stable navigation id rather than translated
// labels so changing display copy can never change the icon or route.
export const ADMIN_NAV_ICONS = Object.freeze({
  home: Object.freeze([
    Object.freeze({ element:'path', d:'M3.75 10.25 12 3.5l8.25 6.75' }),
    Object.freeze({ element:'path', d:'M5.5 9v10.5h13V9M9.25 19.5v-6h5.5v6' }),
  ]),
  alerts: Object.freeze([
    Object.freeze({ element:'path', d:'M18 9.25a6 6 0 0 0-12 0c0 6.75-2.5 6.75-2.5 8.25h17c0-1.5-2.5-1.5-2.5-8.25Z' }),
    Object.freeze({ element:'path', d:'M9.5 20a2.75 2.75 0 0 0 5 0' }),
  ]),
  workforce: Object.freeze([
    Object.freeze({ element:'circle', cx:'8.75', cy:'8', r:'3' }),
    Object.freeze({ element:'path', d:'M3.5 19.5c.45-3.55 2.2-5.25 5.25-5.25S13.55 16 14 19.5' }),
    Object.freeze({ element:'circle', cx:'17', cy:'9', r:'2.25' }),
    Object.freeze({ element:'path', d:'M15.75 14.5c.4-.15.85-.25 1.35-.25 2.15 0 3.35 1.45 3.65 4.25' }),
  ]),
  attendance_exams: Object.freeze([
    Object.freeze({ element:'rect', x:'3.5', y:'5.25', width:'17', height:'15.25', rx:'2.25' }),
    Object.freeze({ element:'path', d:'M7.5 3.5v3.75M16.5 3.5v3.75M3.5 9.5h17M8 15l2.25 2.25L16 12.5' }),
  ]),
  work_execution: Object.freeze([
    Object.freeze({ element:'path', d:'M8.25 5H5.5A1.75 1.75 0 0 0 3.75 6.75v13.5h16.5V6.75A1.75 1.75 0 0 0 18.5 5h-2.75' }),
    Object.freeze({ element:'rect', x:'8.25', y:'3.25', width:'7.5', height:'4', rx:'1.5' }),
    Object.freeze({ element:'path', d:'m7.25 12 1.25 1.25 2.25-2.5M12.75 12h4M7.25 17h9.5' }),
  ]),
  payroll: Object.freeze([
    Object.freeze({ element:'rect', x:'3.25', y:'5.25', width:'17.5', height:'13.5', rx:'2.5' }),
    Object.freeze({ element:'path', d:'M3.25 9.5h17.5M7 14h4.5M16.75 14h.25' }),
  ]),
  account_usage: Object.freeze([
    Object.freeze({ element:'path', d:'M12 3.25 20 6.5v5.25c0 4.75-2.65 7.6-8 9-5.35-1.4-8-4.25-8-9V6.5Z' }),
    Object.freeze({ element:'circle', cx:'12', cy:'10', r:'2.25' }),
    Object.freeze({ element:'path', d:'M8.25 16c.45-2.1 1.7-3.25 3.75-3.25S15.3 13.9 15.75 16' }),
  ]),
})

