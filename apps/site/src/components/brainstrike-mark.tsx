interface BrainstrikeMarkProps {
  readonly className?: string;
}

export function BrainstrikeMark({ className }: BrainstrikeMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M35.2 5.8C31.9 3.9 28.1 3 24 3 13 3 4.2 11.8 4.2 22.8c0 5.6 2.3 10.7 6 14.3l1 6.9h10.2l2.8-4.5"
        stroke="currentColor"
        strokeLinecap="square"
        strokeLinejoin="miter"
        strokeWidth="2.8"
      />
      <path
        d="m28.8 4.5-14 22.1h10.6l-5.2 16.9 15.7-24.7H25.4l8.2-13.1"
        stroke="currentColor"
        strokeLinecap="square"
        strokeLinejoin="miter"
        strokeWidth="3.2"
      />
    </svg>
  );
}
