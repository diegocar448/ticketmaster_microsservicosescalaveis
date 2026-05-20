// apps/web/src/components/ui/button.tsx
//
// Versão mínima compatível com a API do shadcn/ui (variant/size opcionais).
// Capítulos seguintes podem substituir pelo componente gerado pelo CLI.

import type React from 'react';
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'default' | 'outline';
type Size = 'default' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  'inline-flex items-center justify-center rounded-md font-medium transition disabled:opacity-50 disabled:pointer-events-none';

const variants: Record<Variant, string> = {
  default: 'bg-blue-600 text-white hover:bg-blue-700',
  outline: 'border border-gray-300 bg-white hover:bg-gray-50',
};

const sizes: Record<Size, string> = {
  default: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
};

export function Button({
  variant = 'default',
  size = 'default',
  className = '',
  ...props
}: ButtonProps): React.JSX.Element {
  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}
