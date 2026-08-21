function iconClass(extra = "") {
  return `h-4 w-4 ${extra}`.trim();
}

export function IconBack() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="M12.5 4.5 7 10l5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconChevronLeft() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="M12 5 7 10l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconChevronRight() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="m8 5 5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconSparkles({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={iconClass(className)} fill="none" aria-hidden="true">
      <path
        d="M10 3.2c.42 2.1 1.4 3.08 3.5 3.5-2.1.42-3.08 1.4-3.5 3.5-.42-2.1-1.4-3.08-3.5-3.5 2.1-.42 3.08-1.4 3.5-3.5Z"
        fill="currentColor"
      />
      <path
        d="M16.2 11.4c.25 1.25.83 1.83 2.08 2.08-1.25.25-1.83.83-2.08 2.08-.25-1.25-.83-1.83-2.08-2.08 1.25-.25 1.83-.83 2.08-2.08Z"
        fill="currentColor"
      />
      <path
        d="M5.6 11.8c.18.9.6 1.32 1.5 1.5-.9.18-1.32.6-1.5 1.5-.18-.9-.6-1.32-1.5-1.5.9-.18 1.32-.6 1.5-1.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function IconSinglePage() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <rect x="5" y="3.5" width="10" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function IconDoublePage() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="6.5" height="13" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <rect x="11" y="3.5" width="6.5" height="13" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function IconLtr() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="M4 10h11M11 6l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconRtl() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="M16 10H5M9 6 5 10l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconWebtoon() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <rect x="6" y="2.5" width="8" height="5" rx="1" stroke="currentColor" strokeWidth="1.35" />
      <rect x="6" y="8.25" width="8" height="5" rx="1" stroke="currentColor" strokeWidth="1.35" />
      <path d="M10 14.75v2.25m0 0-1.8-1.8M10 17l1.8-1.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconFullscreen() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="M4 8V4h4M12 4h4v4M16 12v4h-4M8 16H4v-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconExitFullscreen() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="M8 4v4H4M12 4v4h4M8 16v-4H4M12 16v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconHideBar() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      {/* 两条横线：与 ShowBar 三条横线形成「收起一行」的折叠语义 */}
      <path d="M4 7h12M4 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconShowBar() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="M4 6.5h12M4 10h12M4 13.5h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconMore() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="10" r="1.35" />
      <circle cx="10" cy="10" r="1.35" />
      <circle cx="15" cy="10" r="1.35" />
    </svg>
  );
}
