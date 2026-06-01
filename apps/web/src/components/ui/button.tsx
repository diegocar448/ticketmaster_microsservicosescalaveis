// apps/web/src/components/ui/button.tsx
//
// Versão mínima compatível com a API do shadcn/ui (variant/size + asChild).
// Capítulos seguintes podem substituir pelo componente gerado pelo CLI.

import React from 'react';
import type { ButtonHTMLAttributes, ReactElement } from 'react';

type Variant = 'default' | 'outline';
type Size = 'default' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  // asChild renderiza no elemento filho (ex: <Link>) em vez de <button>,
  // mesclando as classes — padrão shadcn (sem @radix-ui/react-slot).
  asChild?: boolean;
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
  asChild = false,
  children,
  ...props
}: ButtonProps): React.JSX.Element {
  const merged = `${base} ${variants[variant]} ${sizes[size]} ${className}`;

  if (asChild && React.isValidElement(children)) {
    // Mescla a classe Tailwind no elemento filho (tipicamente <Link>).
    const child = children as ReactElement<{ className?: string }>;
    return React.cloneElement(child, {
      className: `${merged} ${child.props.className ?? ''}`.trim(),
    });
  }

  return (
    <button className={merged} {...props}>
      {children}
    </button>
  );
}
