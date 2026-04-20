# Capítulo 3 — API Gateway

> **Objetivo:** Construir o ponto de entrada único da API — autenticação JWT, rate limiting, roteamento para microserviços, e cabeçalhos de segurança OWASP com Helmet.

## O que você vai aprender

- Por que o API Gateway existe (o problema que resolve)
- JWT validation antes de repassar ao microserviço — nenhum serviço valida token sozinho
- Rate limiting por IP e por usuário com `@nestjs/throttler`
- Proxy reverso tipado com `http-proxy-middleware`
- Helmet.js: configurar os 10+ cabeçalhos HTTP de segurança
- Request ID para rastreamento distribuído (correlação com OpenTelemetry)

---

## Por que centralizar no Gateway?

```
SEM Gateway:
  Cada serviço valida JWT ──→ 5 serviços, 5 implementações de auth
  Cada serviço tem rate limiting ──→ 5 vezes o mesmo código
  Logs dispersos ──→ impossível rastrear uma request cross-service

COM Gateway:
  Auth uma vez ──→ repassa x-user-id, x-organizer-id para serviços internos
  Rate limiting centralizado ──→ um lugar para ajustar
  Request ID único ──→ rastreia a request do início ao fim (OpenTelemetry)
```

---

## Passo 3.1 — Estrutura do API Gateway

```
apps/api-gateway/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── common/
│   │   ├── filters/
│   │   │   └── http-exception.filter.ts    # Formata erros (OWASP: sem stack trace)
│   │   ├── interceptors/
│   │   │   └── request-id.interceptor.ts   # Injeta x-request-id
│   │   └── middleware/
│   │       ├── jwt-auth.middleware.ts       # Valida JWT e extrai claims
│   │       └── logger.middleware.ts         # Loga todas as requests
│   ├── modules/
│   │   ├── proxy/
│   │   │   ├── proxy.module.ts
│   │   │   └── proxy.controller.ts         # Rota todos os paths downstream
│   │   └── health/
│   │       └── health.controller.ts
├── package.json
└── tsconfig.json
```

---

## Passo 3.2 — `main.ts`

```typescript
// apps/api-gateway/src/main.ts

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';
import { Logger } from '@nestjs/common';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Desabilitar logs do NestJS em produção (usar OpenTelemetry)
    logger: process.env.NODE_ENV === 'production'
      ? ['error', 'warn']
      : ['log', 'debug', 'error', 'warn'],

    // CRÍTICO: desabilitar body parser do NestJS.
    // O API Gateway apenas faz proxy — não lê o body das requests.
    // Se o NestJS parsear o body antes, o stream chega vazio ao http-proxy-middleware
    // e a request fica travada esperando dados que nunca chegam (timeout).
    bodyParser: false,
  });

  // ─── OWASP A05: Security Headers via Helmet ─────────────────────────────────
  app.use(
    helmet({
      // Content Security Policy: bloqueia recursos não autorizados
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],  // UI libs exigem isso
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          frameSrc: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
      // HSTS: força HTTPS por 1 ano
      hsts: {
        maxAge: 31_536_000,
        includeSubDomains: true,
        preload: true,
      },
      // Esconde a tecnologia usada (OWASP A05)
      hidePoweredBy: true,
      // Previne clickjacking
      frameguard: { action: 'deny' },
      // Previne MIME sniffing
      noSniff: true,
      // XSS filter para browsers legados
      xssFilter: true,
    }),
  );

  // ─── CORS: apenas origens permitidas ─────────────────────────────────────────
  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
    credentials: true,
    maxAge: 86_400,  // cache preflight por 24h
  });

  // ─── Filters e Interceptors globais ──────────────────────────────────────────
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new RequestIdInterceptor());

  // ─── Swagger (apenas em dev/staging) ─────────────────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');
    const config = new DocumentBuilder()
      .setTitle('ShowPass API')
      .setDescription('Plataforma de venda de ingressos')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);
    Logger.log('Swagger disponível em http://localhost:3000/docs');
  }

  const port = process.env['PORT'] ?? 3000;
  await app.listen(port);
  Logger.log(`API Gateway rodando na porta ${port.toString()}`);
}

void bootstrap();
```

---

## Passo 3.3 — `app.module.ts`

```typescript
// apps/api-gateway/src/app.module.ts

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ProxyModule } from './modules/proxy/proxy.module';
import { HealthModule } from './modules/health/health.module';
import { JwtAuthMiddleware } from './common/middleware/jwt-auth.middleware';
import { LoggerMiddleware } from './common/middleware/logger.middleware';

@Module({
  imports: [
    // ─── Rate Limiting (OWASP A07) ────────────────────────────────────────────
    ThrottlerModule.forRoot([
      {
        // Tier 1: limite global por IP
        name: 'global',
        ttl: 60_000,    // janela de 60 segundos
        limit: 300,     // 300 req/min por IP
      },
      {
        // Tier 2: limite mais restrito para endpoints de auth
        name: 'auth',
        ttl: 60_000,
        limit: 5,       // 5 tentativas de login/min — previne brute force
      },
    ]),

    // HealthModule ANTES de ProxyModule — o ProxyController registra @All('*')
    // que captura qualquer path, incluindo /health/*. Em Express, a PRIMEIRA
    // rota registrada vence, então as rotas específicas (/health/live,
    // /health/ready) precisam ser montadas antes do wildcard. Sem essa ordem
    // o probe de liveness do K8s bate no proxy, que tenta resolver /health
    // como serviço downstream e devolve 404 (ver scripts/dev.sh e CAP-17).
    HealthModule,
    ProxyModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      // Logar todas as requests (ordem importa: logger antes do auth)
      .apply(LoggerMiddleware)
      .forRoutes('*')
      // Auth em todas as rotas exceto as públicas
      .apply(JwtAuthMiddleware)
      .exclude(
        'health',
        'health/*path',
        'docs',
        'docs/*path',
        // Rotas de auth emitem o token — não precisam dele
        { path: 'auth/organizers/register', method: 1 },  // POST
        { path: 'auth/organizers/login',    method: 1 },
        { path: 'auth/organizers/refresh',  method: 1 },
        { path: 'auth/buyers/register',     method: 1 },
        { path: 'auth/buyers/login',        method: 1 },
        { path: 'auth/buyer/login',         method: 1 },  // rota legada
        { path: 'auth/refresh',             method: 1 },
        // Busca de eventos é pública
        { path: 'events',       method: 0 },              // GET
        { path: 'events/*path', method: 0 },
        { path: 'search/*path', method: 0 },
        // Webhook do Stripe — autenticado via HMAC, não JWT
        { path: 'webhooks/stripe', method: 1 },
      )
      .forRoutes('*');
  }
}
```

---

## Passo 3.4 — JWT Auth Middleware

```typescript
// apps/api-gateway/src/common/middleware/jwt-auth.middleware.ts
//
// Valida o JWT e injeta os claims nas headers para os serviços downstream.
// Os serviços internos confiam no x-user-id e x-organizer-id sem revalidar —
// a validação acontece UMA VEZ aqui no gateway.

import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { createPublicKey, verify as jwtVerify } from 'crypto';
import * as jwt from 'jsonwebtoken';

// Formato dos claims do JWT do ShowPass
interface ShowPassJwtPayload {
  sub: string;           // user ID
  email: string;
  type: 'organizer' | 'buyer';
  organizerId?: string;  // apenas para organizers
  iat: number;
  exp: number;
}

@Injectable()
export class JwtAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(JwtAuthMiddleware.name);

  // Chave pública RSA para verificar assinaturas (RS256)
  // Apenas o auth-service tem a chave privada — gateway só verifica
  private readonly publicKey = process.env.JWT_PUBLIC_KEY!
    .replace(/\\n/g, '\n');

  use(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token não fornecido');
    }

    const token = authHeader.substring(7);

    try {
      const payload = jwt.verify(token, this.publicKey, {
        algorithms: ['RS256'],
        // Validar audience para prevenir token de outro serviço ser aceito
        audience: 'showpass-api',
        issuer: 'showpass-auth',
      }) as ShowPassJwtPayload;

      // Injetar claims nas headers para os serviços downstream
      // Os serviços NÃO precisam verificar o JWT de novo
      req.headers['x-user-id'] = payload.sub;
      req.headers['x-user-email'] = payload.email;
      req.headers['x-user-type'] = payload.type;

      if (payload.organizerId) {
        req.headers['x-organizer-id'] = payload.organizerId;
      }

      next();
    } catch (error) {
      const err = error as Error;

      // OWASP A09: logar falhas de auth sem expor detalhes ao cliente
      this.logger.warn('JWT inválido', {
        error: err.message,
        ip: req.ip,
        path: req.path,
      });

      // OWASP A07: mensagem genérica — não dizer "token expirado" vs "token inválido"
      throw new UnauthorizedException('Token inválido ou expirado');
    }
  }
}
```

---

## Passo 3.5 — HTTP Exception Filter (OWASP A09)

```typescript
// apps/api-gateway/src/common/filters/http-exception.filter.ts
//
// Formata TODOS os erros HTTP de forma segura:
// - Em produção: sem stack trace, sem detalhes internos
// - Em desenvolvimento: stack trace completo para debug
// OWASP A05: não vazar informações de implementação ao cliente

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode: number;
    let message: string | string[];

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      message = typeof exceptionResponse === 'object' && 'message' in exceptionResponse
        ? (exceptionResponse as { message: string | string[] }).message
        : exception.message;
    } else {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;

      // OWASP A05: nunca expor erro interno em produção
      message = process.env.NODE_ENV === 'production'
        ? 'Erro interno do servidor'
        : (exception as Error).message;
    }

    // OWASP A09: logar TODOS os erros 5xx com contexto completo
    if (statusCode >= 500) {
      this.logger.error('Erro interno', {
        statusCode,
        path: request.path,
        method: request.method,
        requestId: request.headers['x-request-id'],
        error: exception instanceof Error ? exception.stack : String(exception),
      });
    }

    response.status(statusCode).json({
      statusCode,
      message,
      // Timestamp para correlação com logs
      timestamp: new Date().toISOString(),
      // Request ID para rastreamento cross-service
      requestId: request.headers['x-request-id'] as string,
      path: request.path,
    });
  }
}
```

---

## Passo 3.6 — Request ID Interceptor

```typescript
// apps/api-gateway/src/common/interceptors/request-id.interceptor.ts
//
// Injeta um ID único em cada request — rastreamento distribuído.
// O mesmo ID é repassado a todos os serviços downstream via header.
// No Grafana/Loki você busca por este ID e vê o fluxo completo.

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    // Usar o ID enviado pelo cliente (Cloudflare, load balancer) ou gerar novo
    const requestId =
      (request.headers['x-request-id'] as string | undefined) ??
      (request.headers['cf-ray'] as string | undefined) ??   // Cloudflare Ray ID
      randomUUID();

    // Injetar na request (para filtros e outros middlewares usarem)
    request.headers['x-request-id'] = requestId;

    // Retornar o ID na response para o cliente correlacionar com seus logs
    response.setHeader('x-request-id', requestId);

    return next.handle().pipe(
      tap(() => {
        // Logar tempo de resposta de cada request
        const start = Date.now();
        response.on('finish', () => {
          const duration = Date.now() - start;
          if (duration > 1000) {
            // Alertar sobre requests lentas (> 1s)
            console.warn(`[SLOW REQUEST] ${request.method} ${request.path} - ${duration}ms`);
          }
        });
      }),
    );
  }
}
```

---

## Passo 3.7 — Proxy Controller

```typescript
// apps/api-gateway/src/modules/proxy/proxy.controller.ts
//
// Roteia requests para os microserviços internos.
// O gateway é stateless — apenas valida, enriquece headers, e repassa.

import { All, Controller, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

// Mapa de rotas: prefixo → URL do serviço interno
// Em produção, as URLs vêm de variáveis de ambiente (service discovery)
const SERVICE_MAP: Record<string, string> = {
  '/auth':     process.env.AUTH_SERVICE_URL    ?? 'http://localhost:3006',
  '/events':     process.env.EVENT_SERVICE_URL   ?? 'http://localhost:3003',
  '/venues':     process.env.EVENT_SERVICE_URL   ?? 'http://localhost:3003',
  '/organizers': process.env.EVENT_SERVICE_URL   ?? 'http://localhost:3003',
  '/bookings':   process.env.BOOKING_SERVICE_URL ?? 'http://localhost:3004',
  '/payments':   process.env.PAYMENT_SERVICE_URL ?? 'http://localhost:3002',
  '/search':     process.env.SEARCH_SERVICE_URL  ?? 'http://localhost:3005',
  '/tickets':    process.env.WORKER_SERVICE_URL  ?? 'http://localhost:3007',
  '/webhooks':   process.env.PAYMENT_SERVICE_URL ?? 'http://localhost:3002',
};

@Controller()
export class ProxyController {
  /**
   * Captura todas as rotas e repassa ao serviço correto.
   * O middleware é criado dinamicamente baseado no path da request.
   */
  @All('*')
  async proxy(@Req() req: Request, @Res() res: Response): Promise<void> {
    const targetService = this.resolveTarget(req.path);

    if (!targetService) {
      res.status(404).json({
        statusCode: 404,
        message: `Rota não encontrada: ${req.path}`,
      });
      return;
    }

    // Criar proxy para o serviço alvo
    const proxy = createProxyMiddleware({
      target: targetService,
      changeOrigin: true,
      // Repassar os headers de auth injetados pelo middleware
      headers: {
        'x-forwarded-for': req.ip ?? '',
        'x-real-ip': req.ip ?? '',
      },
      on: {
        error: (err, _req, proxyRes) => {
          const res = proxyRes as Response;
          res.status(503).json({
            statusCode: 503,
            message: 'Serviço temporariamente indisponível',
          });
        },
      },
    });

    proxy(req, res, () => {
      // Nunca chamado — o proxy resolve ou lança erro
    });
  }

  private resolveTarget(path: string): string | null {
    for (const [prefix, url] of Object.entries(SERVICE_MAP)) {
      if (path.startsWith(prefix)) {
        return url;
      }
    }
    return null;
  }
}
```

---

## Passo 3.8 — Health Check

```typescript
// apps/api-gateway/src/modules/health/health.controller.ts
//
// Endpoint de health check — usado pelo Kubernetes liveness/readiness probe.
// Kubernetes bate neste endpoint para saber se o pod está saudável.

import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HttpHealthIndicator,
} from '@nestjs/terminus';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly http: HttpHealthIndicator,
  ) {}

  /**
   * Liveness probe: "o processo está vivo?"
   * Se falhar, Kubernetes reinicia o pod.
   */
  @Get('live')
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * Readiness probe: "o serviço está pronto para receber tráfego?"
   * Se falhar, Kubernetes remove o pod do load balancer.
   */
  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      // Verificar se consegue alcançar os serviços downstream
      () => this.http.pingCheck('event-service', `${process.env.EVENT_SERVICE_URL}/health/live`),
      () => this.http.pingCheck('booking-service', `${process.env.BOOKING_SERVICE_URL}/health/live`),
    ]);
  }
}
```

---

## Passo 3.9 — Logger Middleware

```typescript
// apps/api-gateway/src/common/middleware/logger.middleware.ts
//
// Loga cada request com contexto suficiente para debug em produção.
// Em produção, esses logs vão para o Loki via OpenTelemetry.

import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const { method, originalUrl, ip } = req;
    const requestId = req.headers['x-request-id'] as string;
    const startTime = Date.now();

    res.on('finish', () => {
      const { statusCode } = res;
      const duration = Date.now() - startTime;

      // OWASP A09: logar sem dados sensíveis (sem corpo da request)
      this.logger.log(
        `${method} ${originalUrl} ${statusCode} ${duration}ms`,
        {
          method,
          path: originalUrl,
          statusCode,
          duration,
          ip,
          requestId,
          // User info se disponível (injetado pelo JwtAuthMiddleware)
          userId: req.headers['x-user-id'] as string | undefined,
        },
      );
    });

    next();
  }
}
```

---

## Passo 3.10 — `.env` do API Gateway

```bash
# apps/api-gateway/.env

NODE_ENV=development
PORT=3000

# ── JWT (chave pública RSA — apenas verificação) ──────────────────────────────
# Gerada com: openssl genrsa -out private.pem 4096 && openssl rsa -in private.pem -pubout -out public.pem
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ...\n-----END PUBLIC KEY-----"

# ── Serviços internos ─────────────────────────────────────────────────────────
AUTH_SERVICE_URL=http://auth-service:3006
EVENT_SERVICE_URL=http://event-service:3003
BOOKING_SERVICE_URL=http://booking-service:3004
PAYMENT_SERVICE_URL=http://payment-service:3002
SEARCH_SERVICE_URL=http://search-service:3005
WORKER_SERVICE_URL=http://worker-service:3007

# ── CORS ──────────────────────────────────────────────────────────────────────
ALLOWED_ORIGINS=http://localhost:3000,https://showpass.com.br

# ── Observabilidade ───────────────────────────────────────────────────────────
OTEL_SERVICE_NAME=api-gateway
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

---

## Fluxo completo de uma request autenticada

```
Browser → Cloudflare → API Gateway
                          │
                    LoggerMiddleware
                    RequestIdInterceptor (gera x-request-id)
                          │
                    JwtAuthMiddleware
                     ├── válido? → injeta x-user-id, x-organizer-id
                     └── inválido? → 401 (sem detalhes — OWASP A07)
                          │
                    ThrottlerGuard
                     ├── dentro do limite? → passa
                     └── excedeu? → 429 Too Many Requests
                          │
                    ProxyController
                     └── resolve target service
                          │
                    http-proxy-middleware
                     └── repassa request com headers de auth injetados
                          │
                    event-service / booking-service / etc.
                     └── confia no x-user-id sem verificar JWT de novo
```

---

## Passo 3.X — Fila de Espera Virtual (Virtual Waiting Room)

> **Problema:** No dia de venda do show do Bruno Mars, 10 milhões de usuários tentam acessar simultaneamente.  
> Se todos entrarem de uma vez, a arquitetura cai — mesmo com auto-scaling, escalar de 3 para 50 pods leva ~30 segundos.
>
> Além disso: **bots** conseguem fazer requisições muito mais rápido que humanos.  
> E usuários com **conexões de menor latência** (ex: servidores na mesma cidade do datacenter) teriam vantagem injusta.
>
> **Solução:** Fila de espera virtual com token aleatório — F5 não ajuda, localização não importa.

### Como funciona

```
  Usuário acessa /events/bruno-mars-sp/tickets
       │
       ▼
  API Gateway detecta: evento em alta demanda (> threshold de tráfego)
       │
       ├─ Usuário JÁ tem token de fila? → verificar posição → entrar ou esperar
       │
       └─ Usuário SEM token?
            │
            ▼
         Gerar token UUID aleatório
         Atribuir posição na fila (Redis Sorted Set — score = timestamp de entrada)
         Redirecionar para /waiting-room?token=UUID&position=4523
            │
            ▼
         Frontend faz polling a cada 5s: "qual minha posição agora?"
            │
            ├─ Posição > 0 → mostrar contador, mensagem de espera
            │
            └─ Posição = 0 → emitir "admission token" (JWT curto, 10min TTL)
                             Usuário entra com o admission token
                             Booking Service aceita apenas requisições com admission token válido

  A cada N segundos, o sistema avança a fila em lotes de 100 usuários.
  Isso garante que a arquitetura só recebe 100 novos usuários por intervalo —
  não 10 milhões de uma vez.
```

### Implementação: WaitingRoomService

```typescript
// apps/api-gateway/src/modules/waiting-room/waiting-room.service.ts
//
// Fila de espera virtual baseada em Redis Sorted Set.
//
// Redis Sorted Set = estrutura onde cada membro tem um score numérico.
// Usamos timestamp de entrada como score → ordena por chegada (FIFO).
//
// Comandos-chave:
//   ZADD queue:{eventId} {timestamp} {token}  → entrar na fila
//   ZRANK queue:{eventId} {token}              → posição (0 = próximo)
//   ZREMRANGEBYRANK queue:{eventId} 0 99       → avançar 100 usuários

import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@showpass/redis';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';

const BATCH_SIZE = 100;        // usuários admitidos por avanço de fila
const ADVANCE_INTERVAL_MS = 5_000;  // avançar fila a cada 5 segundos
const ADMISSION_TOKEN_TTL = 600;    // 10 minutos para completar a compra
const HIGH_DEMAND_THRESHOLD = 1000; // ativar fila quando > 1000 req/s no evento

@Injectable()
export class WaitingRoomService {
  private readonly logger = new Logger(WaitingRoomService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Verifica se um evento está em modo de alta demanda.
   * Usa um contador Redis para medir req/s por evento.
   */
  async isHighDemand(eventId: string): Promise<boolean> {
    const key = `traffic:${eventId}`;
    const count = await this.redis.incrementAvailable(key);

    // Setar TTL de 1s na primeira chamada (janela deslizante de 1 segundo)
    if (count === 1) {
      await this.redis.set(key, count, 1);
    }

    return count > HIGH_DEMAND_THRESHOLD;
  }

  /**
   * Entra na fila de espera para um evento.
   * Gera um token único e aleatório — posição determinada pelo timestamp.
   *
   * Por que aleatório?
   *   Token aleatório (UUID) não pode ser previsto ou manipulado.
   *   A posição na fila é baseada em quando o token foi gerado — não em
   *   quem tem a conexão mais rápida ou qual bot enviou mais requisições.
   *   F5 gera um NOVO token em uma posição PIOR — punição para quem spama.
   */
  async joinQueue(eventId: string): Promise<{
    token: string;
    position: number;
    estimatedWaitSeconds: number;
  }> {
    const token = randomUUID();
    const score = Date.now();

    // ZADD: adiciona o token com score = timestamp atual
    // Sorted Set garante unicidade — não é possível entrar duas vezes
    await this.redis['redis'].zadd(`queue:${eventId}`, score, token);

    const position = await this.getPosition(eventId, token);
    const estimatedWaitSeconds = Math.ceil((position / BATCH_SIZE) * (ADVANCE_INTERVAL_MS / 1000));

    this.logger.log(`Token ${token} entrou na fila de ${eventId} na posição ${position}`);

    return { token, position, estimatedWaitSeconds };
  }

  /**
   * Retorna a posição atual do token na fila.
   * Posição 0 significa que o usuário pode entrar agora.
   */
  async getPosition(eventId: string, token: string): Promise<number> {
    const rank = await this.redis['redis'].zrank(`queue:${eventId}`, token);
    return rank ?? -1;  // -1 = token inválido ou expirado
  }

  /**
   * Emite um "admission token" JWT quando o usuário chega ao início da fila.
   * Este token é passado nas requisições de booking — sem ele, o Booking Service rejeita.
   */
  async admitUser(eventId: string, token: string): Promise<string | null> {
    const position = await this.getPosition(eventId, token);

    if (position !== 0) return null;  // ainda não é a vez do usuário

    // Remover da fila
    await this.redis['redis'].zrem(`queue:${eventId}`, token);

    // Emitir admission token (JWT de curta duração)
    return this.jwt.sign(
      { eventId, waitingRoomToken: token, admitted: true },
      { expiresIn: ADMISSION_TOKEN_TTL },
    );
  }

  /**
   * Job que avança a fila de 100 em 100 a cada 5 segundos.
   * Chamado por um @Cron no WaitingRoomScheduler.
   * Os primeiros 100 da fila recebem admission token via WebSocket/SSE.
   */
  async advanceQueue(eventId: string): Promise<string[]> {
    // Pegar os primeiros 100 tokens da fila (score mais baixo = chegaram primeiro)
    const admitted = await this.redis['redis'].zrange(`queue:${eventId}`, 0, BATCH_SIZE - 1);

    if (admitted.length === 0) return [];

    // Remover os admitidos da fila
    await this.redis['redis'].zremrangebyrank(`queue:${eventId}`, 0, BATCH_SIZE - 1);

    this.logger.log(`Fila ${eventId}: ${admitted.length} usuários admitidos`);

    return admitted;  // caller notifica via WebSocket
  }
}
```

### Middleware no API Gateway

```typescript
// apps/api-gateway/src/modules/waiting-room/waiting-room.middleware.ts
//
// Intercepta requisições de compra de ingressos em eventos de alta demanda.
// Se o evento está em modo de fila → verificar se o usuário tem admission token.

import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { WaitingRoomService } from './waiting-room.service';

@Injectable()
export class WaitingRoomMiddleware implements NestMiddleware {
  constructor(private readonly waitingRoom: WaitingRoomService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Apenas para rotas de reserva
    if (!req.path.includes('/bookings/reservations')) {
      return next();
    }

    const eventId = req.body?.eventId as string | undefined;
    if (!eventId) return next();

    // Verificar se está em alta demanda
    const highDemand = await this.waitingRoom.isHighDemand(eventId);
    if (!highDemand) return next();

    // Verificar admission token (header personalizado)
    const admissionToken = req.headers['x-admission-token'] as string | undefined;

    if (!admissionToken) {
      // Sem token → mandar para a fila de espera
      const queue = await this.waitingRoom.joinQueue(eventId);

      res.status(202).json({
        message: 'Evento em alta demanda. Você entrou na fila de espera.',
        waitingRoom: {
          token: queue.token,
          position: queue.position,
          estimatedWaitSeconds: queue.estimatedWaitSeconds,
          pollingUrl: `/waiting-room/${eventId}/position?token=${queue.token}`,
        },
      });
      return;
    }

    // Com token → validar e continuar
    next();
  }
}
```

### Opção alternativa: Cloudflare Waiting Room

> Para produção sem implementar do zero, o **Cloudflare Waiting Room** oferece exatamente este comportamento como serviço gerenciado:

```yaml
# infra/cloudflare/waiting-room.yaml
# Configurar via Cloudflare API ou Terraform provider

waiting_room:
  name: "showpass-ticket-sale"
  host: "api.showpass.com.br"
  path: "/bookings/reservations"

  # Quantidade de usuários ativos simultaneamente
  total_active_users: 5000

  # Novos usuários admitidos por intervalo
  new_users_per_minute: 1200  # = 100 a cada 5 segundos

  # Sessão válida por 10 minutos após admissão
  session_duration: 10

  # Template customizado da página de espera (HTML/CSS do ShowPass)
  custom_page_enabled: true
```

```
Cloudflare Waiting Room vs. Implementação própria:

  Cloudflare:
  + Zero código para manter
  + Protege na borda (antes do tráfego chegar ao servidor)
  + Bot detection incluído (Cloudflare Bot Management)
  - Custo adicional ($$$)
  - Menos controle sobre a lógica de fila

  Redis próprio:
  + Controle total
  + Integrado com sua lógica de negócio
  + Gratuito
  - Mais código para manter
  - Tráfego ainda chega ao servidor antes da fila
```

---

## Testando na prática

O API Gateway em si não tem lógica de negócio — ele valida JWT e faz proxy. Os testes mais interessantes ficam no Cap 04 (auth) e Cap 05 (eventos). Mas você já pode verificar o health check e o comportamento de rejeição de requests.

### O que precisa estar rodando

```bash
docker compose up -d
pnpm --filter api-gateway run dev
```

O gateway sobe na porta **3000**.

### Passo a passo

**1. Health check — liveness**

```bash
curl http://localhost:3000/health/live
```

Resposta esperada:

```json
{ "status": "ok" }
```

**2. Health check — readiness**

```bash
curl http://localhost:3000/health/ready
```

Resposta esperada (formato padrão do `@nestjs/terminus`):

```json
{
  "status": "ok",
  "info": {
    "event-service": { "status": "up" },
    "booking-service": { "status": "up" }
  },
  "error": {},
  "details": {
    "event-service": { "status": "up" },
    "booking-service": { "status": "up" }
  }
}
```

Se um dos serviços downstream estiver fora do ar, você verá `"status": "error"` com o serviço em questão movido de `info` para `error`.

**3. Verificar rejeição de request sem token**

```bash
curl -i http://localhost:3000/events
```

Resposta esperada:

```http
HTTP/1.1 401 Unauthorized
{"statusCode":401,"message":"Token não fornecido","timestamp":"...","requestId":"..."}
```

Observe o campo `requestId` — ele é gerado pelo `RequestIdInterceptor` e aparece em todos os erros.

**4. Verificar rate limiting**

Execute este loop para disparar mais de 5 requests de autenticação em sequência:

```bash
for i in {1..6}; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://localhost:3000/auth/buyers/login \
    -H "Content-Type: application/json" \
    -d '{"email":"x@x.com","password":"errado"}';
done
```

Os primeiros retornam `401` (credenciais erradas). Na 6ª request (limite é 5/min), você verá `429 Too Many Requests`.

> **Nota:** o rate limit de auth (5 req/min) é mais restritivo que o global (300 req/min). Se quiser testar o global, use endpoints diferentes em sequência rápida.

**5. Verificar header `x-request-id` na resposta**

```bash
curl -I http://localhost:3000/health/live
```

Procure o header `x-request-id` na resposta. Ele é gerado pelo gateway e propagado para todos os serviços downstream — usado para rastreamento nos logs do Loki/Grafana.

---

## Recapitulando

1. **JWT validado uma vez** no Gateway — RS256 com chave pública; serviços internos confiam nos headers `x-user-id` / `x-organizer-id`
2. **Helmet.js** configurado com CSP, HSTS, X-Frame-Options — OWASP A05
3. **Rate limiting em dois tiers**: global (300 req/min) e auth (5 req/min) — OWASP A07
4. **HttpExceptionFilter** sem stack trace em produção — OWASP A05/A09
5. **Request ID** propagado em todas as respostas — rastreamento cross-service no Loki/Grafana
6. **Health checks** separados para liveness e readiness — Kubernetes usa ambos
7. **Fila de espera virtual** — token aleatório, lotes de 100 usuários, F5 não ajuda, geolocalização não privilegia ninguém

---

## Próximo capítulo

[Capítulo 4 → Auth Service](cap-04-auth-service.md)
