-- =====================================================================
--  ArchivÉo — Isolation par UPE en LECTURE sur documents
--
--  Avant : doc_select using (true) — tout compte authentifié lisait les
--  documents de toutes les provinces. L'isolation annoncée dans les règles
--  du projet ne s'appliquait qu'en écriture.
--  Après : un agent ne voit que sa province ; Kinshasa (rôles « national »
--  et « super_admin ») conserve la vue nationale.
--
--  Appliquée le 25/08/2026 — sans impact sur l'existant : les 147 documents
--  archivés à cette date étaient tous rattachés à Kinshasa.
-- =====================================================================

drop policy if exists doc_select on documents;

create policy doc_select on documents
  for select to authenticated
  using (is_admin_scope() or province = jwt_province());

-- Le journal d'activité référence des documents : même portée.
drop policy if exists log_select on activity_log;

create policy log_select on activity_log
  for select to authenticated
  using (
    document_id is null
    or exists (
      select 1 from documents d
      where d.id = activity_log.document_id
        and (is_admin_scope() or d.province = jwt_province())
    )
  );
