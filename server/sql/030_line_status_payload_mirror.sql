-- 030: нормализованные ревизии статуса машины всегда совпадают с payload.
--
-- 025 добавил к line_truck_statuses колонки status_revision/cycle_revision/
-- ttn_revision и объявил инвариант «payload зеркалит колонки»: v2-снимок
-- читает колонки, а доменные правила (applyLineOperation) сравнивают
-- payload.cycleRevision. Пока писали только v2-хранилища, обе стороны были
-- согласованы. Старый (v1) путь операций линии обновлял ТОЛЬКО payload, поэтому
-- cycle_revision оставался прежним: клиент получал из снимка устаревшую
-- ревизию, отправлял её в CAS и получал 409 «Погрузка уже учтена или прибытие
-- изменилось» на ровном месте.
--
-- Триггер делает инвариант свойством таблицы, а не соглашением между
-- хранилищами: любой писатель (v1 line-store, история/undo, control line.add,
-- восстановление архива, replica, backup-restore) обновляет колонки вместе с
-- payload. Явные значения колонок v2-хранилищ совпадают с payload, поэтому для
-- них триггер — no-op.
--
-- Правило намеренно узкое: колонка выводится только из корректного
-- положительного целого в payload. Payload без ревизии (старая строка) и
-- нечисловое значение не переписывают колонку и не роняют запись — иначе
-- легаси-импорт и восстановление резервной копии стали бы невозможны.
BEGIN;

CREATE OR REPLACE FUNCTION line_truck_status_payload_mirror() RETURNS trigger
LANGUAGE plpgsql AS $status_mirror$
DECLARE
  cycle_text text;
  ttn_text text;
BEGIN
  IF jsonb_typeof(NEW.payload) = 'object' THEN
    cycle_text := NULLIF(btrim(NEW.payload->>'cycleRevision'), '');
    IF cycle_text ~ '^[1-9][0-9]{0,18}$' THEN
      NEW.cycle_revision := cycle_text::bigint;
    END IF;
    ttn_text := NULLIF(btrim(NEW.payload->>'ttnRevision'), '');
    IF ttn_text ~ '^[1-9][0-9]{0,18}$' THEN
      NEW.ttn_revision := ttn_text::bigint;
    END IF;
  END IF;
  RETURN NEW;
END
$status_mirror$;

CREATE TRIGGER line_truck_statuses_payload_mirror
  BEFORE INSERT OR UPDATE ON line_truck_statuses
  FOR EACH ROW EXECUTE FUNCTION line_truck_status_payload_mirror();

-- Уже рассинхронизированные строки чинятся один раз: без backfill первый же
-- снимок после миграции снова отдал бы старую колонку. Значения берутся из
-- payload, потому что именно его сравнивают доменные правила.
UPDATE line_truck_statuses
   SET cycle_revision = (payload->>'cycleRevision')::bigint
 WHERE jsonb_typeof(payload->'cycleRevision') = 'number'
   AND (payload->>'cycleRevision') ~ '^[1-9][0-9]{0,18}$'
   AND cycle_revision IS DISTINCT FROM (payload->>'cycleRevision')::bigint;

UPDATE line_truck_statuses
   SET ttn_revision = (payload->>'ttnRevision')::bigint
 WHERE jsonb_typeof(payload->'ttnRevision') = 'number'
   AND (payload->>'ttnRevision') ~ '^[1-9][0-9]{0,18}$'
   AND ttn_revision IS DISTINCT FROM (payload->>'ttnRevision')::bigint;

-- Как и у остальных триггеров линии, функция не выдаётся PUBLIC: это
-- операционная таблица, а не точка расширения.
REVOKE ALL ON FUNCTION line_truck_status_payload_mirror() FROM PUBLIC;

COMMIT;
