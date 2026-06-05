// cn padrão do shadcn: clsx (concatenação condicional) + tailwind-merge (dedupe
// de classes Tailwind conflitantes, ex.: px-2 + px-4 → px-4).
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
