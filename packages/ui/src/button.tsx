"use client";

import type { ReactNode } from "react";

interface ButtonProps {
  children: ReactNode;
  className?: string;
  appName: string;
  onClick?: (appName: string) => void;
}

export const Button = ({
  children,
  className,
  appName,
  onClick,
}: ButtonProps) => {
  return (
    <button
      className={className}
      onClick={() => onClick?.(appName)}
      type="button"
    >
      {children}
    </button>
  );
};
