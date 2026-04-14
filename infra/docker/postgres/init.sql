-- infra/docker/postgres/init.sql
-- Cria um database por serviço — isolamento de dados (bounded context no nível de dados)
-- Cada serviço só acessa o seu próprio banco — nunca o de outro serviço.

CREATE DATABASE showpass_auth;
CREATE DATABASE showpass_events;
CREATE DATABASE showpass_booking;
CREATE DATABASE showpass_payment;

-- Usuários com acesso restrito por database (principle of least privilege — OWASP A01)
-- Um bug ou comprometimento do event-service NÃO tem acesso ao banco de pagamentos
--
-- CREATEDB: necessário APENAS em desenvolvimento para o `prisma migrate dev` criar
-- o banco shadow (usado para detectar drift de migrations). Em produção, as migrations
-- são aplicadas com `prisma migrate deploy` pelo pipeline CI/CD com credenciais de superusuário.
CREATE USER auth_svc    WITH PASSWORD 'auth_svc_dev'    CREATEDB;
CREATE USER event_svc   WITH PASSWORD 'event_svc_dev'   CREATEDB;
CREATE USER booking_svc WITH PASSWORD 'booking_svc_dev' CREATEDB;
CREATE USER payment_svc WITH PASSWORD 'payment_svc_dev' CREATEDB;

GRANT ALL PRIVILEGES ON DATABASE showpass_auth    TO auth_svc;
GRANT ALL PRIVILEGES ON DATABASE showpass_events  TO event_svc;
GRANT ALL PRIVILEGES ON DATABASE showpass_booking TO booking_svc;
GRANT ALL PRIVILEGES ON DATABASE showpass_payment TO payment_svc;

-- Grant no schema public para cada serviço no seu próprio banco
-- Necessário no PostgreSQL 15+ onde o schema public não é mais world-writable
\connect showpass_auth
GRANT ALL ON SCHEMA public TO auth_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE auth_svc IN SCHEMA public GRANT ALL ON TABLES TO auth_svc;

\connect showpass_events
GRANT ALL ON SCHEMA public TO event_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE event_svc IN SCHEMA public GRANT ALL ON TABLES TO event_svc;

\connect showpass_booking
GRANT ALL ON SCHEMA public TO booking_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE booking_svc IN SCHEMA public GRANT ALL ON TABLES TO booking_svc;

\connect showpass_payment
GRANT ALL ON SCHEMA public TO payment_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE payment_svc IN SCHEMA public GRANT ALL ON TABLES TO payment_svc;
