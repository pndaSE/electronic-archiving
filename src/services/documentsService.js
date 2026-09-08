import { supabase } from '../lib/supabaseClient';

const PROVINCES = ['Kinshasa', 'Kwilu', 'Kasaï', 'Kasaï Central'];

const provinceAliases = {
  kasai: 'Kasaï',
  kasaicentral: 'Kasaï Central',
  kwilu: 'Kwilu',
  kinshasa: 'Kinshasa',
};

const normalizeProvinceFilter = (province) => {
  if (!province) return null;

  const normalized = String(province).trim();
  if (normalized.toLowerCase() === 'toutes provinces') return null;

  const aliasKey = normalized
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');

  return provinceAliases[aliasKey] || normalized;
};

function buildDocumentsQuery({ search = '', categoryId = null, serviceId = null, dateStart = null, dateEnd = null, province = null } = {}) {
  let query = supabase
    .from('documents')
    .select('*, categories(name, color), services(name)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (search) {
    const term = search.replace(/[%,()]/g, ' ').trim();
    query = query.or(
      `name.ilike.%${term}%,original_name.ilike.%${term}%,sender.ilike.%${term}%,` +
      `subject.ilike.%${term}%,ai_summary.ilike.%${term}%,content_text.ilike.%${term}%`
    );
  }
  if (categoryId) query = query.eq('category_id', categoryId);
  if (serviceId) query = query.eq('service_id', serviceId);
  if (dateStart) query = query.gte('doc_date', dateStart);
  if (dateEnd) query = query.lte('doc_date', dateEnd);

  const provinceFilter = normalizeProvinceFilter(province);
  if (provinceFilter) query = query.eq('province', provinceFilter);

  return query;
}

export async function listDocuments({ search = '', categoryId = null, serviceId = null, dateStart = null, dateEnd = null, province = null } = {}) {
  const query = buildDocumentsQuery({ search, categoryId, serviceId, dateStart, dateEnd, province });
  const { data, error } = await query;

  if (error) throw error;

  return data ?? [];
}

export async function listTrash({ province = null } = {}) {
  let query = supabase
    .from('documents')
    .select('*, categories(name, color), services(name)')
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false });

  const provinceFilter = normalizeProvinceFilter(province);
  if (provinceFilter) query = query.eq('province', provinceFilter);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function getProvinceStats() {
  const fallback = PROVINCES.map((province) => ({ province, count: 0, sizeKb: 0 }));

  const { data, error } = await supabase
    .from('documents')
    .select('province, size_kb, page_count')
    .is('deleted_at', null);

  if (error) {
    return fallback;
  }

  const stats = PROVINCES.map((province) => ({ province, count: 0, sizeKb: 0 }));
  for (const doc of data || []) {
    const province = doc.province || 'Kinshasa';
    const match = stats.find((item) => item.province === province);
    if (!match) continue;
    match.count += 1;
    match.sizeKb += Number(doc.size_kb || 0);
  }

  return stats;
}

export async function getDocument(id) {
  const { data, error } = await supabase
    .from('documents')
    .select('*, categories(name, color), services(name)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

export async function createDocument(payload) {
  const { data, error } = await supabase
    .from('documents')
    .insert(payload)
    .select('*, categories(name, color), services(name)')
    .single();
  if (error) throw error;
  return data;
}

export async function updateDocument(id, payload) {
  const { province, ...safePayload } = payload || {};

  const { data, error } = await supabase
    .from('documents')
    .update({ ...safePayload, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*, categories(name, color), services(name)')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteDocument(id) {
  const { error } = await supabase
    .from('documents')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function restoreDocument(id) {
  const { error } = await supabase
    .from('documents')
    .update({ deleted_at: null })
    .eq('id', id);
  if (error) throw error;
}

export async function permanentlyDeleteDocument(id) {
  const { error } = await supabase.from('documents').delete().eq('id', id);
  if (error) throw error;
}

export async function countDocuments() {
  const { count, error } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true })
    .is('deleted_at', null);
  if (error) throw error;
  return count ?? 0;
}

export async function sumDocumentSizeKb() {
  const { data, error } = await supabase.from('documents').select('size_kb').is('deleted_at', null);
  if (error) throw error;
  return data.reduce((acc, d) => acc + (d.size_kb || 0), 0);
}
