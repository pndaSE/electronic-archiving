import React, { useEffect, useRef, useState } from 'react';
import {
  HandCoins, Upload, FolderOpen, FileText, Loader2, Sparkles, Save, CheckCircle2, Mail,
  Calendar, User, Tag, Building2, ClipboardList, ShieldAlert, RefreshCw,
} from 'lucide-react';
import { extractPdfText, renderPdfFirstPage, renderPdfPagesAsBase64 } from '../services/pdfTextExtractor';
import { summarizeDocument } from '../services/aiAgentService';
import { listCategories } from '../services/categoriesService';
import { listServiceGroups, listServices } from '../services/servicesService';
import { createDocument } from '../services/documentsService';
import { logActivity } from '../services/activityLogService';
import { uploadDocumentFile } from '../services/storageService';
import { normalizeFinanceFields, runFinanceChecks } from '../services/financeChecksService';
import { saveAnomalies } from '../services/anomaliesService';
import AnomaliesLiasse from '../components/AnomaliesLiasse';
import { useSession } from '../context/SessionContext';

const EXT_TYPE = {
  pdf: 'Document PDF',
  doc: 'Document Word',
  docx: 'Document Word',
  jpg: 'Image numérisée',
  jpeg: 'Image numérisée',
  png: 'Image numérisée',
  tiff: 'Image numérisée',
  tif: 'Image numérisée',
  txt: 'Texte brut',
};

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png']);

// Natures de traitement : chacune déclenche ses propres contrôles métier.
const NATURES = [
  { value: '', label: 'Aucun contrôle métier' },
  { value: 'finance', label: 'Liasse financière' },
];

const INDICES_FINANCE = [
  /liasse/i, /bordereau/i, /ch[eè]que/i, /d[eé]caissement/i, /paiement/i,
  /forfait/i, /indemnit/i, /grille de contr[oô]le/i, /journal\s*BQ/i,
  /\bBQ\d{3,}\b/i, /imputation/i, /d[eé]bit/i, /cr[eé]dit/i,
];

/** Propose une nature de traitement à partir du nom de fichier et du texte lu. */
function detecterNature(fileName, contentText) {
  const cible = `${fileName} ${(contentText || '').slice(0, 4000)}`;
  const score = INDICES_FINANCE.reduce((acc, r) => acc + (r.test(cible) ? 1 : 0), 0);
  return score >= 2 ? 'finance' : '';
}

let tempId = 0;

async function extractContent(file, ext) {
  if (ext === 'pdf') {
    try {
      const { text, pageCount } = await extractPdfText(file);
      return { contentText: text, pageCount };
    } catch {
      return { contentText: '', pageCount: 1 };
    }
  }
  if (ext === 'txt') {
    const text = await file.text();
    return { contentText: text, pageCount: 1 };
  }
  return { contentText: '', pageCount: 1 };
}

async function buildPreview(file, ext) {
  try {
    if (ext === 'pdf') return await renderPdfFirstPage(file);
    if (IMAGE_EXT.has(ext) || ext === 'tif' || ext === 'tiff') return URL.createObjectURL(file);
  } catch {
    return null;
  }
  return null;
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const EMPTY_FORM = {
  title: '', docDate: '', sender: '', subject: '',
  categoryId: '', serviceId: '', tags: '', summary: '',
};

function normalizeLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function parseDocumentDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (!match) return '';
  const [, day, month, year] = match;
  return `${year.length === 2 ? `20${year}` : year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function extractLabeledValue(text, labels) {
  const pattern = labels.join('|');
  const line = String(text || '')
    .split(/\r?\n/)
    .find(value => new RegExp(`^\\s*(?:${pattern})\\s*[:：-]`, 'i').test(value));
  return line?.replace(new RegExp(`^\\s*(?:${pattern})\\s*[:：-]\\s*`, 'i'), '').trim() || '';
}

export default function Importation({ onBack }) {
  const { session } = useSession();
  const [dragging, setDragging] = useState(false);
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [serviceGroups, setServiceGroups] = useState([]);
  const [services, setServices] = useState([]);
  const inputRef = useRef(null);
  const metadataReady = useRef(null);

  useEffect(() => {
    metadataReady.current = Promise.all([listCategories(), listServiceGroups(), listServices()]);
    metadataReady.current
      .then(([loadedCategories, loadedServiceGroups, loadedServices]) => {
        setCategories(loadedCategories);
        setServiceGroups(loadedServiceGroups);
        setServices(loadedServices);
      })
      .catch(() => {});
  }, []);

  const updateItem = (id, patch) => {
    setItems(prev => prev.map(it => (it.id === id ? { ...it, ...patch } : it)));
  };

  const patchForm = (id, patch) => {
    setItems(prev => prev.map(it => (it.id === id ? { ...it, form: { ...it.form, ...patch } } : it)));
  };

  // Analyse IA d'un fichier déjà lu. Isolée de processFile pour pouvoir être
  // relancée quand l'archiviste change la nature du traitement.
  const lancerAnalyse = async ({ id, file, ext, docType, contentText, nature }) => {
    updateItem(id, { status: 'analyzing', nature, anomalies: [], financeFields: null });
    const [loadedCategories, , loadedServices] = await (metadataReady.current
      || Promise.all([listCategories(), listServiceGroups(), listServices()]));

    try {
      let imageBase64, imagesBase64, imageMediaType;
      if (!contentText && IMAGE_EXT.has(ext) && file.size < 4.5 * 1024 * 1024) {
        imageBase64 = await fileToBase64(file);
        imageMediaType = ext === 'png' ? 'image/png' : 'image/jpeg';
      } else if (ext === 'pdf' && (!contentText || nature === 'finance')) {
        // Une liasse financière est toujours relue en vision : les visas, les
        // signatures et les mentions manuscrites n'existent pas dans le calque texte.
        try {
          const rendered = await renderPdfPagesAsBase64(file);
          imagesBase64 = rendered.imagesBase64;
          imageMediaType = rendered.mediaType;
        } catch {
          // sans rendu possible, l'IA se basera sur le texte ou le nom du fichier
        }
      }

      const result = await summarizeDocument({
        fileName: file.name,
        docType,
        nature,
        contentText,
        imageBase64,
        imagesBase64,
        imageMediaType,
        categories: loadedCategories.map(c => c.name),
        services: loadedServices.map(s => s.name),
      });

      // L'IA extrait, le programme vérifie : aucun calcul n'est délégué au modèle.
      let financeFields = null;
      let anomalies = [];
      if (nature === 'finance' && result.fields) {
        financeFields = normalizeFinanceFields(result.fields);
        anomalies = runFinanceChecks(financeFields, {
          confidence: result.confidence,
          analysePartielle: result.analysePartielle,
          pagesAnalysees: result.pagesAnalysees,
        });
      }

      const matchedCategory = loadedCategories.find(c => normalizeLabel(c.name) === normalizeLabel(result.category));
      const matchedService = loadedServices.find(s => normalizeLabel(s.name) === normalizeLabel(result.serviceName));
      const extractedSender = extractLabeledValue(contentText, ['expéditeur', 'expediteur', 'auteur', 'de']);
      const extractedSubject = extractLabeledValue(contentText, ['objet', 'subject']);

      updateItem(id, {
        status: 'ready',
        aiResult: result,
        financeFields,
        anomalies,
        contentText: contentText || result.extractedText || '',
        form: {
          title: result.title || file.name.replace(/\.[^.]+$/, ''),
          docDate: parseDocumentDate(result.docDate || extractLabeledValue(contentText, ['date'])),
          sender: result.sender || extractedSender,
          subject: result.subject || extractedSubject,
          categoryId: matchedCategory ? matchedCategory.id : '',
          serviceId: matchedService ? matchedService.id : '',
          tags: (result.tags || []).join(', '),
          summary: result.summary || '',
        },
      });
    } catch (err) {
      updateItem(id, { status: 'error', error: err.message });
    }
  };

  /** Relance l'analyse quand l'archiviste corrige la nature du traitement. */
  const changerNature = (item, nature) => {
    const ext = item.name.split('.').pop()?.toLowerCase() || '';
    lancerAnalyse({
      id: item.id,
      file: item.file,
      ext,
      docType: item.docType,
      contentText: item.contentText,
      nature,
    });
  };

  const processFile = async (file) => {
    const id = ++tempId;
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const docType = EXT_TYPE[ext] || 'Autre';
    await (metadataReady.current || Promise.all([listCategories(), listServiceGroups(), listServices()]));

    setItems(prev => [...prev, {
      id, file, name: file.name, sizeKb: Math.round(file.size / 1024), docType,
      status: 'reading', contentText: '', pageCount: 1, aiResult: null, previewUrl: null,
      form: { ...EMPTY_FORM, title: file.name.replace(/\.[^.]+$/, '') },
    }]);

    const [{ contentText, pageCount }, previewUrl] = await Promise.all([
      extractContent(file, ext),
      buildPreview(file, ext),
    ]);
    updateItem(id, { contentText, pageCount, previewUrl, status: 'analyzing' });
    await lancerAnalyse({
      id, file, ext, docType, contentText,
      nature: detecterNature(file.name, contentText),
    });
  };

  const handleFiles = (fileList) => {
    Array.from(fileList).forEach(processFile);
  };

  const handleArchive = async (item) => {
    updateItem(item.id, { status: 'saving' });
    try {
      let fileUrl = null;
      try {
        fileUrl = await uploadDocumentFile(item.file, item.name, session?.province);
      } catch {
        fileUrl = null; // l'archivage se poursuit même si l'upload de la pièce échoue
      }

      const newDoc = await createDocument({
        name: item.form.title || item.name,
        original_name: item.name,
        category_id: item.form.categoryId || null,
        service_id: item.form.serviceId || null,
        doc_type: item.docType,
        source: 'upload',
        province: session?.province || 'Kinshasa',
        status: 'archived',
        size_kb: item.sizeKb,
        page_count: item.pageCount,
        content_text: item.contentText,
        file_url: fileUrl,
        ai_summary: item.form.summary,
        ai_tags: item.form.tags.split(',').map(t => t.trim()).filter(Boolean),
        ai_confidence: item.aiResult?.confidence ?? null,
        ai_fields: item.financeFields || {},
        doc_date: item.form.docDate || null,
        sender: item.form.sender || null,
        subject: item.form.subject || null,
      });
      await logActivity({ documentId: newDoc.id, action: 'upload', detail: `Import : ${item.name}` });
      await logActivity({
        documentId: newDoc.id,
        action: 'ai_summary',
        detail: item.aiResult?.demo ? 'Résumé généré (mode démo, sans clé IA)' : 'Résumé généré par Claude',
      });

      if (item.anomalies?.length) {
        await saveAnomalies(newDoc.id, item.anomalies);
        await logActivity({
          documentId: newDoc.id,
          action: 'controle_metier',
          detail: `${item.anomalies.length} anomalie(s) relevée(s) sur la liasse`,
        });
      }
      updateItem(item.id, { status: 'saved' });
    } catch (err) {
      updateItem(item.id, { status: 'error', error: err.message });
    }
  };

  const inputCls = 'bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-white outline-none focus:border-teal-500/60 w-full placeholder-slate-400 dark:placeholder-slate-500';
  const labelCls = 'text-slate-500 text-[11px] font-medium flex items-center gap-1';

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex items-center gap-4">
        <div className="p-3 rounded-xl bg-[#008B8B]">
          <HandCoins className="h-6 w-6 text-white" strokeWidth={1.5} />
        </div>
        <div>
          <h2 className="text-xl md:text-2xl font-bold text-slate-900 dark:text-white">Importation</h2>
          <p className="text-slate-500 text-sm">Importer des documents depuis votre appareil</p>
        </div>
        <button
          onClick={onBack}
          className="ml-auto px-4 py-2 bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/20 border border-slate-200 dark:border-white/10 rounded-xl text-xs font-semibold text-slate-900 dark:text-white transition-all"
        >
          ← Accueil
        </button>
      </div>

      <hr className="border-slate-200 dark:border-white/10" />

      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.tiff,.tif,.txt"
        className="hidden"
        onChange={e => { handleFiles(e.target.files); e.target.value = ''; }}
      />

      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl flex flex-col items-center justify-center gap-3 transition-all min-h-28 cursor-pointer ${
          dragging
            ? 'border-teal-400 bg-teal-500/10'
            : 'border-slate-300 dark:border-white/20 bg-slate-100/50 dark:bg-white/5 hover:bg-slate-100 dark:hover:bg-white/10 hover:border-slate-400 dark:hover:border-white/30'
        }`}
      >
        <Upload className={`h-8 w-8 transition-colors ${dragging ? 'text-teal-400' : 'text-slate-400'}`} />
        <div className="text-center">
          <p className="text-slate-900 dark:text-white font-medium text-sm">Glissez vos fichiers ici, ou cliquez pour parcourir</p>
          <p className="text-slate-500 text-xs mt-1">PDF, DOCX, JPEG, TIFF, TXT · lus et pré-classés automatiquement par l'IA</p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <button
          onClick={() => inputRef.current?.click()}
          className="flex-1 flex items-center justify-center gap-2 bg-[#008B8B] hover:bg-[#008B8B]/80 text-white py-3 rounded-xl font-semibold text-sm transition-all"
        >
          <FolderOpen className="h-4 w-4" /> Parcourir les fichiers
        </button>
        <button
          disabled
          title="Nécessite une configuration IMAP côté serveur (à venir)"
          className="flex-1 flex items-center justify-center gap-2 bg-slate-100 dark:bg-white/5 text-slate-400 py-3 rounded-xl font-semibold text-sm border border-slate-200 dark:border-white/10 cursor-not-allowed"
        >
          <Mail className="h-4 w-4" /> Depuis l'e-mail (bientôt)
        </button>
      </div>

      <div className="flex-1 flex flex-col gap-4 overflow-auto">
        {items.map(item => (
          <div key={item.id} className="bg-slate-100/80 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-4 flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <FileText className="h-5 w-5 text-teal-500 dark:text-teal-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-slate-900 dark:text-white text-sm font-medium truncate">{item.name}</p>
                <p className="text-slate-500 text-xs">{item.docType} · {item.sizeKb} Ko · {item.pageCount} page(s)</p>
              </div>
              {item.status === 'reading' && <span className="text-xs text-slate-500 flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Lecture…</span>}
              {item.status === 'analyzing' && <span className="text-xs text-blue-600 dark:text-blue-300 flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Analyse IA…</span>}
              {item.status === 'saving' && <span className="text-xs text-slate-500 flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Enregistrement…</span>}
              {item.status === 'error' && <span className="text-xs text-red-500 dark:text-red-400">{item.error}</span>}
              {item.status === 'saved' && <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" /> Archivé</span>}
            </div>

            {(item.status === 'ready' || item.status === 'saving') && (
              <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">

                <div className="bg-slate-200/50 dark:bg-slate-950/40 border border-slate-200 dark:border-white/10 rounded-lg p-3 flex items-start justify-center overflow-auto max-h-80 lg:max-h-none">
                  {item.previewUrl ? (
                    <img
                      src={item.previewUrl}
                      alt={`Aperçu de ${item.name}`}
                      className="rounded shadow-xl max-w-full h-auto bg-white"
                    />
                  ) : item.contentText ? (
                    <pre className="text-slate-600 dark:text-slate-300 text-[11px] whitespace-pre-wrap font-mono w-full max-h-72 overflow-auto">
                      {item.contentText.slice(0, 1200)}{item.contentText.length > 1200 ? '…' : ''}
                    </pre>
                  ) : (
                    <div className="text-slate-400 text-xs flex flex-col items-center gap-2 py-8">
                      <FileText className="h-8 w-8 opacity-30" />
                      Aperçu non disponible pour ce format
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-2.5">
                  {item.aiResult?.demo && !item.aiResult?.fallbackReason ? (
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5 text-amber-700 dark:text-amber-300 text-xs flex items-start gap-2">
                      <Sparkles className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>
                        <strong>Clé IA non configurée</strong> — la fiche n'a pas pu être pré-remplie automatiquement.
                        Configurez <code className="bg-amber-500/20 rounded px-1">ANTHROPIC_API_KEY</code> dans les secrets de votre projet Supabase
                        (Tableau de bord → Edge Functions → Secrets) puis relancez l'analyse.
                      </span>
                    </div>
                  ) : (
                    <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-2.5 text-slate-600 dark:text-slate-300 text-xs flex items-start gap-2">
                      <Sparkles className="h-3.5 w-3.5 text-blue-500 dark:text-blue-400 shrink-0 mt-0.5" />
                      <span>Fiche pré-remplie par l'agent IA — vérifiez et corrigez si besoin.</span>
                    </div>
                  )}

                  <div className="flex flex-col gap-1">
                    <span className={labelCls}><ShieldAlert className="h-3 w-3" /> Contrôles métier</span>
                    <div className="flex items-center gap-2">
                      <select
                        value={item.nature || ''}
                        onChange={e => changerNature(item, e.target.value)}
                        disabled={item.status === 'analyzing'}
                        className={`${inputCls} disabled:opacity-50`}
                      >
                        {NATURES.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
                      </select>
                      <button
                        type="button"
                        onClick={() => changerNature(item, item.nature || '')}
                        disabled={item.status === 'analyzing'}
                        title="Relancer l'analyse"
                        className="shrink-0 rounded-lg border border-slate-200 dark:border-white/10 p-2 text-slate-400 hover:text-teal-500 disabled:opacity-50 transition-colors"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${item.status === 'analyzing' ? 'animate-spin' : ''}`} />
                      </button>
                    </div>
                  </div>

                  {item.nature === 'finance' && item.status === 'ready' && (
                    item.financeFields ? (
                      <AnomaliesLiasse
                        anomalies={item.anomalies || []}
                        fields={item.financeFields}
                      />
                    ) : (
                      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-300">
                        Aucune structure financière n'a pu être extraite : les contrôles automatiques
                        n'ont pas pu s'exécuter. Vérifiez la liasse manuellement avant d'archiver.
                      </div>
                    )
                  )}

                  {item.aiResult?.fallbackReason && (
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5 text-amber-600 dark:text-amber-300 text-xs">
                      ⚠ Analyse IA indisponible (API inaccessible ou crédit épuisé) — la fiche a été remplie
                      par une analyse locale simplifiée. Vérifiez attentivement chaque champ avant d'archiver.
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <label className="flex flex-col gap-1 sm:col-span-2">
                      <span className={labelCls}><FileText className="h-3 w-3" /> Titre</span>
                      <input value={item.form.title} onChange={e => patchForm(item.id, { title: e.target.value })} className={inputCls} />
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className={labelCls}><Calendar className="h-3 w-3" /> Date du document</span>
                      <input type="date" value={item.form.docDate} onChange={e => patchForm(item.id, { docDate: e.target.value })} className={inputCls} />
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className={labelCls}><User className="h-3 w-3" /> Expéditeur / Auteur</span>
                      <input value={item.form.sender} onChange={e => patchForm(item.id, { sender: e.target.value })} placeholder="Ex. Kivu Solutions Sarl" className={inputCls} />
                    </label>

                    <label className="flex flex-col gap-1 sm:col-span-2">
                      <span className={labelCls}><ClipboardList className="h-3 w-3" /> Objet</span>
                      <input value={item.form.subject} onChange={e => patchForm(item.id, { subject: e.target.value })} placeholder="Objet du document" className={inputCls} />
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className={labelCls}><Tag className="h-3 w-3" /> Nature</span>
                      <select value={item.form.categoryId} onChange={e => patchForm(item.id, { categoryId: e.target.value })} className={inputCls}>
                        <option value="">Non classé</option>
                        {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className={labelCls}><Building2 className="h-3 w-3" /> Service concerné</span>
                      <select value={item.form.serviceId} onChange={e => patchForm(item.id, { serviceId: e.target.value })} className={inputCls}>
                        <option value="">Non affecté</option>
                        {serviceGroups.map(g => (
                          <optgroup key={g.id} label={g.name}>
                            {g.services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </label>

                    <label className="flex flex-col gap-1 sm:col-span-2">
                      <span className={labelCls}><Tag className="h-3 w-3" /> Mots-clés</span>
                      <input value={item.form.tags} onChange={e => patchForm(item.id, { tags: e.target.value })} className={inputCls} />
                    </label>

                    <label className="flex flex-col gap-1 sm:col-span-2">
                      <span className={labelCls}><Sparkles className="h-3 w-3" /> Résumé (modifiable)</span>
                      <textarea
                        value={item.form.summary}
                        onChange={e => patchForm(item.id, { summary: e.target.value })}
                        rows={3}
                        className={`${inputCls} resize-none`}
                      />
                    </label>
                  </div>

                  <button
                    onClick={() => handleArchive(item)}
                    disabled={item.status === 'saving'}
                    className="self-start flex items-center gap-2 bg-emerald-600 hover:bg-emerald-600/80 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-xs font-semibold transition-all"
                  >
                    {item.status === 'saving' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Archiver ce document
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {items.length === 0 && (
          <p className="text-slate-500 text-sm text-center py-6">Aucun fichier en cours d'import.</p>
        )}
      </div>
    </div>
  );
}
