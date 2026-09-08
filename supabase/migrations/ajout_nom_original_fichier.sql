-- =====================================================================
--  ArchivÉo — Conservation du nom de fichier d'origine
--
--  « name » porte le titre proposé par l'IA. Le nom du fichier tel qu'il
--  sort du scanner (BQ0416_260821_125456.pdf) était perdu à l'archivage,
--  alors que c'est souvent lui que l'agent a en tête quand il cherche.
--
--  Appliquée le 25/08/2026 : 148 documents sur 149 repris automatiquement.
-- =====================================================================

alter table documents
  add column if not exists original_name text;

comment on column documents.original_name is
  'Nom du fichier tel qu''il a été importé ou scanné, avant renommage par l''IA.';

-- Reprise de l'existant : le nom d'origine est récupérable dans le chemin
-- de stockage, qui suit le motif « <province>/<horodatage>-<nom original> ».
update documents
set original_name = regexp_replace(regexp_replace(file_url, '^.*/', ''), '^\d+-', '')
where original_name is null
  and file_url is not null
  and file_url like '%/documents/%';

-- Recherche approximative sur le nom d'origine (pg_trgm est déjà installé).
create index if not exists documents_original_name_trgm
  on documents using gin (original_name gin_trgm_ops);
