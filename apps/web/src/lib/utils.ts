// apps/web/src/lib/utils.ts
//
// Helpers utilitários. `cn` mantém o padrão do shadcn/ui (concatenação
// condicional de classes Tailwind) sem trazer `clsx` + `tailwind-merge`
// — bundle menor, suficiente para nosso uso.

export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(' ');
}
