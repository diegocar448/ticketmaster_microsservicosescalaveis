// apps/web/src/components/ui/input.tsx
//
// Input mínimo compatível com shadcn/ui. React 19 aceita `ref` como prop
// normal (sem forwardRef) — react-hook-form passa ref via {...register}.

import type React from 'react';
import type { InputHTMLAttributes, Ref } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

export function Input({
  className = '',
  ...props
}: InputProps): React.JSX.Element {
  return (
    <input
      className={
        'flex h-10 w-full rounded-md border border-gray-300 px-3 text-sm ' +
        'focus:outline-none focus:ring-2 focus:ring-blue-500 ' +
        'aria-[invalid=true]:border-red-500 ' +
        className
      }
      {...props}
    />
  );
}
