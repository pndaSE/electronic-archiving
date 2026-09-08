-- =====================================================================
--  ArchivÉo — Bucket « documents » privé et isolé par UPE
--
--  ⚠ À APPLIQUER SEULEMENT APRÈS DÉPLOIEMENT DU CODE qui consomme des
--    URL signées (storageService.getDocumentUrl). Tant que l'ancien
--    bundle est en ligne, il utilise des URL publiques et l'aperçu des
--    pièces cesserait de fonctionner.
--
--  Avant : bucket public — toute personne connaissant l'URL téléchargeait
--  les pièces scannées (contrats, chèques, pièces d'identité) sans aucune
--  authentification.
--  Après : bucket privé, accès par URL signée, soumis aux mêmes règles
--  d'isolation par province que la table documents.
-- =====================================================================

-- Dossier de stockage correspondant à la province du porteur du jeton.
-- Reflète sanitizeFileName() côté application : accents retirés,
-- espaces remplacés par des tirets bas.
create or replace function public.jwt_province_folder()
returns text language sql stable set search_path to 'public' as $$
  select case public.jwt_province()
    when 'Kinshasa'      then 'Kinshasa'
    when 'Kwilu'         then 'Kwilu'
    when 'Kasaï'         then 'Kasai'
    when 'Kasaï Central' then 'Kasai_Central'
    else translate(public.jwt_province(),
                   'àâäéèêëïîôöùûüçÀÂÄÉÈÊËÏÎÔÖÙÛÜÇ ',
                   'aaaeeeeiioouuucAAAEEEEIIOOUUUC_')
  end
$$;

update storage.buckets set public = false where id = 'documents';

drop policy if exists "Documents publicly readable"    on storage.objects;
drop policy if exists "Documents insert authenticated" on storage.objects;
drop policy if exists "Documents update authenticated" on storage.objects;
drop policy if exists "Documents delete authenticated" on storage.objects;
drop policy if exists "Documents insertable by anon"   on storage.objects;
drop policy if exists "Documents updatable by anon"    on storage.objects;
drop policy if exists "Documents deletable by anon"    on storage.objects;

create policy "Documents lisibles par la province" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (public.is_admin_scope() or (storage.foldername(name))[1] = public.jwt_province_folder())
  );

create policy "Documents deposables par la province" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (public.is_admin_scope() or (storage.foldername(name))[1] = public.jwt_province_folder())
  );

create policy "Documents modifiables par la province" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and (public.is_admin_scope() or (storage.foldername(name))[1] = public.jwt_province_folder())
  );

create policy "Documents supprimables par la province" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and public.jwt_access_level() <> 'user'
    and (public.is_admin_scope() or (storage.foldername(name))[1] = public.jwt_province_folder())
  );
