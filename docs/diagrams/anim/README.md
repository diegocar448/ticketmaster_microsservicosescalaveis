# Animação da arquitetura (GIF para LinkedIn)

Gera `docs/diagrams/showpass-arquitetura.gif` — um GIF animado, estilo claro/corporativo,
mostrando a visão geral da stack (painel direito) + o fluxo de compra passo a passo
(reserva → Redis SETNX → Kafka → checkout Stripe → saga → ingresso).

## Como funciona

- **`scene.html`** — desenha tudo num `<canvas>` via uma função determinística `draw(t)`,
  onde `t ∈ [0,1)` é o tempo normalizado do loop. Sem dependências externas no browser.
- **`render.js`** — usa Puppeteer (Chromium headless) para chamar `draw(t)` em cada frame,
  lê o `canvas.toDataURL()`, decodifica com `pngjs` e codifica o GIF com `gifenc`
  (pipeline 100% JS — **não precisa de ffmpeg**).

## Regenerar

```bash
# Dependências (uma vez) — em qualquer diretório com node_modules acessível
npm install puppeteer gifenc pngjs

# Renderizar (ajuste os caminhos de require() em render.js se mudar a pasta do node_modules)
node render.js ../showpass-arquitetura.gif
```

Parâmetros no topo do `render.js`: `FPS`, `SECONDS`, dimensões `W`/`H` e o tamanho da
paleta (`quantize(data, 128, ...)`). Mais cores/frames = arquivo maior. O alvo é < 5 MB
(limite confortável do LinkedIn, que converte GIF em vídeo no feed).

## Editar o conteúdo

Tudo está em `scene.html`:
- **`N`** — nós (posição, label, cor, forma).
- **`E`** — arestas (origem/destino/cor, `dashed` para assíncrono).
- **`PHASES`** — os 6 passos do fluxo (quais arestas/nós acendem, legenda, item da stack).
- **`STACK`** — lista de serviços do painel direito.
- **`COL`** — paleta corporativa.
