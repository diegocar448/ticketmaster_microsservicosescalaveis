-- infra/docker/postgres/init.sql
-- Cria um database por serviço — isolamento de dados (bounded context no nível de dados)
-- Cada serviço só acessa o seu próprio banco — nunca o de outro serviço.

CREATE DATABASE showpass_auth;
CREATE DATABASE showpass_events;
CREATE DATABASE showpass_booking;
CREATE DATABASE showpass_payment;

-- Usuários com acesso restrito por database (principle of least privilege — OWASP A01)
-- Um bug ou comprometimento do event-service NÃO tem acesso ao banco de pagamentos
CREATE USER auth_svc WITH PASSWORD 'auth_svc_dev';
CREATE USER event_svc WITH PASSWORD 'event_svc_dev';
CREATE USER booking_svc WITH PASSWORD 'booking_svc_dev';
CREATE USER payment_svc WITH PASSWORD 'payment_svc_dev';

GRANT ALL PRIVILEGES ON DATABASE showpass_auth    TO auth_svc;
GRANT ALL PRIVILEGES ON DATABASE showpass_events  TO event_svc;
GRANT ALL PRIVILEGES ON DATABASE showpass_booking TO booking_svc;
GRANT ALL PRIVILEGES ON DATABASE showpass_payment TO payment_svc;
