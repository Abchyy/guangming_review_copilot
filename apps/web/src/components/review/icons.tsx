import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function baseProps(props: IconProps): IconProps {
  return {
    width: 14,
    height: 14,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
    ...props,
  };
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M3 8.5l3.2 3.2L13 5" />
    </svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M8 2.2 14.4 13H1.6L8 2.2Z" />
      <path d="M8 6.4v3" />
      <path d="M8 11.4v.1" />
    </svg>
  );
}

export function IconExternal(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M6.5 3.5H3.5v9h9V9.5" />
      <path d="M9.5 3.5h3v3" />
      <path d="M12.2 3.8 7.5 8.5" />
    </svg>
  );
}

export function IconLocate(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <circle cx="8" cy="8" r="4.6" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2" />
    </svg>
  );
}

export function IconBook(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M3 3.2c1.5-.7 3.2-.6 5 .4 1.8-1 3.5-1.1 5-.4v9.6c-1.5-.7-3.2-.6-5 .4-1.8-1-3.5-1.1-5-.4V3.2Z" />
      <path d="M8 3.6v9.6" />
    </svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.7 2.3v2.6h-2.6" />
    </svg>
  );
}

export function IconSealCheck(props: IconProps) {
  return (
    <svg {...baseProps(props)} width={28} height={28} strokeWidth={1.4}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M5.5 8.2 7.6 10.3 11 6" />
    </svg>
  );
}
