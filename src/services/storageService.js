import { supabase } from '../lib/supabaseClient';

const BUCKET = 'documents';

function sanitizeFileName(name) {
  return String(name || 'fichier')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_');
}

/**
 * Upload un fichier (File ou Blob) vers le bucket de stockage "documents"
 * et retourne son chemin de stockage. Utilisé pour permettre l'affichage et
 * l'impression de la pièce scannée/importée depuis les Archives.
 */
export async function uploadDocumentFile(fileOrBlob, fileName, province = null) {
  const safeName = sanitizeFileName(fileName);
  const folder = province ? sanitizeFileName(province) : 'divers';
  const path = `${folder}/${Date.now()}-${safeName}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, fileOrBlob, { upsert: false });
  if (error) throw error;

  // On stocke le CHEMIN et non une URL publique : le bucket est privé, l'accès
  // se fait par URL signée, soumise aux politiques RLS de l'utilisateur.
  return path;
}

const MARQUEUR_PUBLIC = '/storage/v1/object/public/documents/';

/**
 * Retrouve le chemin dans le bucket à partir d'un chemin nu ou d'une ancienne
 * URL publique (les documents archivés avant le passage en bucket privé).
 */
export function toStoragePath(valeur) {
  if (!valeur) return null;
  const texte = String(valeur);
  const i = texte.indexOf(MARQUEUR_PUBLIC);
  if (i >= 0) return decodeURIComponent(texte.slice(i + MARQUEUR_PUBLIC.length).split('?')[0]);
  if (/^https?:\/\//i.test(texte)) return null; // URL externe : rien à signer
  return texte.replace(/^\/+/, '');
}

/**
 * URL signée temporaire pour consulter ou imprimer une pièce.
 * Renvoie null si l'utilisateur n'a pas le droit de lire le fichier.
 */
export async function getDocumentUrl(valeur, expiresInSeconds = 3600) {
  const path = toStoragePath(valeur);
  if (!path) return valeur || null;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) return null;
  return data?.signedUrl ?? null;
}

export function dataUrlToBlob(dataUrl) {
  const [meta, base64] = dataUrl.split(',');
  const mime = meta.match(/data:(.*);base64/)?.[1] || 'image/jpeg';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
