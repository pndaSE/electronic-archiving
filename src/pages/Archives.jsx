import React, { useEffect, useState } from 'react';
import { DatabaseIcon, Search, Filter, Eye, Trash2, MessageCircle, X, Sparkles, Loader2, Printer, Share2, Download, CheckSquare, Square, ZoomIn, ZoomOut, RotateCw, FileImage, Trash, RotateCcw, XCircle } from 'lucide-react';
import { listDocuments, listTrash, deleteDocument, restoreDocument, permanentlyDeleteDocument, getDocument } from '../services/documentsService';
import { countOpenAnomalies } from '../services/anomaliesService';
import { getDocumentUrl } from '../services/storageService';
import AnomaliesLiasse, { BadgeConformite } from '../components/AnomaliesLiasse';
import { listCategories } from '../services/categoriesService';
import { listServiceGroups } from '../services/servicesService';
import { logActivity } from '../services/activityLogService';
import { listShares, createShare, deleteShare } from '../services/sharesService';
import { addToQueue } from '../services/printQueueService';
import { useChat } from '../context/ChatContext';
import { useSession } from '../context/SessionContext';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import * as XLSX from 'xlsx';

function formatSize(kb) {
  if (!kb) return '—';
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} Mo` : `${kb} Ko`;
}

function formatDate(doc) {
  const raw = doc.doc_date || doc.created_at;
  return raw ? raw.slice(0, 10) : '—';
}

export default function Archives({ onBack, focusDocumentId = null, onFocusHandled }) {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [dateRangeStart, setDateRangeStart] = useState('');
  const [dateRangeEnd, setDateRangeEnd] = useState('');
  const [categories, setCategories] = useState([]);
  const [serviceGroups, setServiceGroups] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [provinceFilter, setProvinceFilter] = useState('Toutes provinces');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewTab, setPreviewTab] = useState('resume');
  const [docZoom, setDocZoom] = useState(1);
  const [docRotation, setDocRotation] = useState(0);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareEmails, setShareEmails] = useState(['']);
  const [shareAccessLevel, setShareAccessLevel] = useState('Lecture');
  const [trashMode, setTrashMode] = useState(false);
  const [anomaliesParDoc, setAnomaliesParDoc] = useState({});
  const [fichierSigne, setFichierSigne] = useState(null);
  const { openChat } = useChat();
  const { session, isSuperAdmin, canDeleteDocuments } = useSession();

  useEffect(() => {
    listCategories().then(setCategories).catch(err => setError(err.message));
    listServiceGroups().then(setServiceGroups).catch(() => {});
  }, []);

  useEffect(() => {
    if (!focusDocumentId) return;
    getDocument(focusDocumentId)
      .then(doc => setPreview(doc))
      .catch(() => setError('Document introuvable (supprimé ?)'))
      .finally(() => onFocusHandled?.());
  }, [focusDocumentId]);

  useEffect(() => {
    setPreviewTab('resume');
    setDocZoom(1);
    setDocRotation(0);
  }, [preview?.id]);

  useEffect(() => {
    setLoading(true);
    setSelectedIds(new Set());
    const provinceScope = isSuperAdmin ? provinceFilter : session?.province;

    if (trashMode) {
      listTrash({ province: provinceScope })
        .then(setDocuments)
        .catch(err => setError(err.message))
        .finally(() => setLoading(false));
      return;
    }

    const timeout = setTimeout(() => {
      listDocuments({
        search,
        categoryId: categoryFilter || null,
        serviceId: serviceFilter || null,
        dateStart: dateRangeStart || null,
        dateEnd: dateRangeEnd || null,
        province: provinceScope,
      })
        .then(setDocuments)
        .catch(err => setError(err.message))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timeout);
  }, [search, categoryFilter, serviceFilter, dateRangeStart, dateRangeEnd, isSuperAdmin, provinceFilter, session?.province, trashMode]);

  // Compteurs d'anomalies ouvertes, pour la pastille de conformité des liasses.
  useEffect(() => {
    const liasses = documents.filter(d => d.ai_fields?.nature === 'finance').map(d => d.id);
    if (!liasses.length) {
      setAnomaliesParDoc({});
      return;
    }
    let vivant = true;
    countOpenAnomalies(liasses)
      .then(compteurs => { if (vivant) setAnomaliesParDoc(compteurs); })
      .catch(() => {});
    return () => { vivant = false; };
  }, [documents]);

  const handleDelete = async (doc) => {
    if (!canDeleteDocuments) return;
    if (!window.confirm(`Mettre "${doc.name}" à la corbeille ?`)) return;
    await deleteDocument(doc.id);
    await logActivity({ documentId: null, action: 'trash', detail: `Document mis à la corbeille : ${doc.name}` });
    setDocuments(docs => docs.filter(d => d.id !== doc.id));
    if (preview?.id === doc.id) setPreview(null);
  };

  const handleRestore = async (doc) => {
    if (!canDeleteDocuments) return;
    await restoreDocument(doc.id);
    await logActivity({ documentId: null, action: 'restore', detail: `Document restauré : ${doc.name}` });
    setDocuments(docs => docs.filter(d => d.id !== doc.id));
    if (preview?.id === doc.id) setPreview(null);
  };

  const handlePermanentDelete = async (doc) => {
    if (!canDeleteDocuments) return;
    if (!window.confirm(`Supprimer définitivement "${doc.name}" ? Cette action est irréversible.`)) return;
    await permanentlyDeleteDocument(doc.id);
    await logActivity({ documentId: null, action: 'delete_permanent', detail: `Document supprimé définitivement : ${doc.name}` });
    setDocuments(docs => docs.filter(d => d.id !== doc.id));
    if (preview?.id === doc.id) setPreview(null);
  };

  const isPdfFile = (url) => /\.pdf($|\?)/i.test(url || '');

  // Le bucket est privé : chaque consultation passe par une URL signée,
  // délivrée seulement si les politiques RLS autorisent l'utilisateur.
  useEffect(() => {
    if (!preview?.file_url) {
      setFichierSigne(null);
      return;
    }
    let vivant = true;
    setFichierSigne(null);
    getDocumentUrl(preview.file_url)
      .then(url => { if (vivant) setFichierSigne(url); })
      .catch(() => { if (vivant) setFichierSigne(null); });
    return () => { vivant = false; };
  }, [preview?.id, preview?.file_url]);

  const printPreviewFile = () => {
    if (!fichierSigne) return;
    const win = window.open(fichierSigne, '_blank');
    if (win) setTimeout(() => { try { win.print(); } catch { /* impression annulée ou bloquée */ } }, 800);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === documents.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(documents.map(d => d.id)));
    }
  };

  const toggleSelectId = (id) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const handleBatchPrint = async () => {
    if (selectedIds.size === 0) return;
    const totalPages = documents
      .filter(d => selectedIds.has(d.id))
      .reduce((sum, d) => sum + (d.page_count || 1), 0);

    try {
      await addToQueue({
        documentId: Array.from(selectedIds)[0],
        pages: totalPages,
        isBatch: true,
        batchDocIds: Array.from(selectedIds),
      });
      await logActivity({
        action: 'print_batch',
        detail: `Impression en masse: ${selectedIds.size} documents, ${totalPages} pages`,
      });
      setSelectedIds(new Set());
      alert(`${selectedIds.size} document(s) ajouté(s) à la file d'impression (${totalPages} pages)`);
    } catch (err) {
      setError(`Erreur lors de l'impression: ${err.message}`);
    }
  };

  const handleBatchShare = async () => {
    if (selectedIds.size === 0 || !shareEmails.some(e => e.trim())) return;
    try {
      const validEmails = shareEmails.filter(e => e.trim());
      let shareCount = 0;

      for (const email of validEmails) {
        for (const docId of selectedIds) {
          await createShare({
            document_id: docId,
            shared_with: email.trim(),
            access_level: shareAccessLevel,
            expires_at: null,
          });
          shareCount++;
        }
      }

      await logActivity({
        action: 'share_batch',
        detail: `Partage en masse: ${selectedIds.size} docs vers ${validEmails.length} destinataires`,
      });

      setSelectedIds(new Set());
      setShareModalOpen(false);
      setShareEmails(['']);
      alert(`${shareCount} partage(s) créé(s) avec succès`);
    } catch (err) {
      setError(`Erreur lors du partage: ${err.message}`);
    }
  };

  const handleBatchDelete = async () => {
    if (!canDeleteDocuments || selectedIds.size === 0) return;
    if (!window.confirm(`Mettre ${selectedIds.size} document(s) à la corbeille ?`)) return;

    try {
      for (const docId of selectedIds) {
        const doc = documents.find(d => d.id === docId);
        await deleteDocument(docId);
        await logActivity({ documentId: null, action: 'trash_batch', detail: `Mise à la corbeille: ${doc.name}` });
      }
      setDocuments(docs => docs.filter(d => !selectedIds.has(d.id)));
      setSelectedIds(new Set());
      alert(`${selectedIds.size} document(s) mis à la corbeille`);
    } catch (err) {
      setError(`Erreur lors de la suppression: ${err.message}`);
    }
  };

  const handleBatchRestore = async () => {
    if (!canDeleteDocuments || selectedIds.size === 0) return;
    try {
      for (const docId of selectedIds) {
        const doc = documents.find(d => d.id === docId);
        await restoreDocument(docId);
        await logActivity({ documentId: null, action: 'restore_batch', detail: `Restauration: ${doc.name}` });
      }
      setDocuments(docs => docs.filter(d => !selectedIds.has(d.id)));
      setSelectedIds(new Set());
      alert(`${selectedIds.size} document(s) restauré(s)`);
    } catch (err) {
      setError(`Erreur lors de la restauration: ${err.message}`);
    }
  };

  const handleBatchPermanentDelete = async () => {
    if (!canDeleteDocuments || selectedIds.size === 0) return;
    if (!window.confirm(`Supprimer définitivement ${selectedIds.size} document(s) ? Cette action est irréversible.`)) return;

    try {
      for (const docId of selectedIds) {
        const doc = documents.find(d => d.id === docId);
        await permanentlyDeleteDocument(docId);
        await logActivity({ documentId: null, action: 'delete_permanent_batch', detail: `Suppression définitive: ${doc.name}` });
      }
      setDocuments(docs => docs.filter(d => !selectedIds.has(d.id)));
      setSelectedIds(new Set());
      alert(`${selectedIds.size} document(s) supprimé(s) définitivement`);
    } catch (err) {
      setError(`Erreur lors de la suppression définitive: ${err.message}`);
    }
  };

  const handleExportPDF = async () => {
    try {
      const element = document.getElementById('export-table');
      if (!element) return;

      const canvas = await html2canvas(element, { scale: 2, backgroundColor: '#ffffff' });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('l', 'mm', 'a4');

      const imgWidth = 280;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      pdf.addImage(imgData, 'PNG', 10, 10, imgWidth, imgHeight);
      pdf.save(`export-archiveo-${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (err) {
      setError(`Erreur lors de l'export PDF: ${err.message}`);
    }
  };

  const handleExportExcel = () => {
    try {
      const exportData = documents.map((doc, index) => ({
        'N°': index + 1,
        'Document': doc.name,
        'Fichier d\'origine': doc.original_name || '—',
        'Nature': doc.categories?.name || doc.doc_type || 'Non classé',
        'Service': doc.services?.name || '—',
        'Date': formatDate(doc),
        'Taille': formatSize(doc.size_kb),
      }));

      const ws = XLSX.utils.json_to_sheet(exportData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Documents');
      XLSX.writeFile(wb, `export-archiveo-${new Date().toISOString().split('T')[0]}.xlsx`);
    } catch (err) {
      setError(`Erreur lors de l'export Excel: ${err.message}`);
    }
  };

  const resetFilters = () => {
    setSearch('');
    setCategoryFilter('');
    setServiceFilter('');
    setDateRangeStart('');
    setDateRangeEnd('');
    setProvinceFilter('Toutes provinces');
    setSelectedIds(new Set());
  };

  return (
    <div className="flex flex-col gap-6 h-full relative">
      <div className="flex items-center gap-4">
        <div className="p-3 rounded-xl bg-[#7AC143]">
          <DatabaseIcon className="h-6 w-6 text-white" strokeWidth={1.5} />
        </div>
        <div>
          <h2 className="text-xl md:text-2xl font-bold text-slate-900 dark:text-white">{trashMode ? 'Corbeille' : 'Archives'}</h2>
          <p className="text-slate-500 text-sm">
            {documents.length} document{documents.length > 1 ? 's' : ''} {trashMode ? 'dans la corbeille' : 'archivé' + (documents.length > 1 ? 's' : '')}
          </p>
        </div>
        {canDeleteDocuments && (
          <button
            onClick={() => setTrashMode(m => !m)}
            className={`ml-auto flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all border ${
              trashMode
                ? 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400'
                : 'bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/20 border-slate-200 dark:border-white/10 text-slate-900 dark:text-white'
            }`}
          >
            {trashMode ? <XCircle className="h-3.5 w-3.5" /> : <Trash className="h-3.5 w-3.5" />}
            {trashMode ? 'Retour aux archives' : 'Corbeille'}
          </button>
        )}
        <button
          onClick={onBack}
          className={`${canDeleteDocuments ? '' : 'ml-auto '}px-4 py-2 bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/20 border border-slate-200 dark:border-white/10 rounded-xl text-xs font-semibold text-slate-900 dark:text-white transition-all`}
        >
          ← Accueil
        </button>
      </div>

      <hr className="border-slate-200 dark:border-white/10" />

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-red-600 dark:text-red-300 text-sm">{error}</div>
      )}

      {trashMode && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 text-amber-600 dark:text-amber-300 text-xs">
          Les documents mis à la corbeille ne sont plus visibles dans les Archives. Restaurez-les ou supprimez-les définitivement (action irréversible).
        </div>
      )}

      {!trashMode && (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 dark:border-white/10 bg-white/70 dark:bg-white/[0.03] p-2 backdrop-blur-sm">
        <div className="flex-1 min-w-[240px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Rechercher (titre, nom du fichier, expéditeur, objet, résumé, contenu)..."
            className="w-full bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg pl-8 pr-3 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 outline-none focus:border-slate-400 dark:focus:border-white/30 transition-all"
          />
        </div>

        <div className="relative min-w-[150px]">
          <select
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
            className="w-full py-2 px-3 bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-white/10 transition-all text-xs outline-none appearance-none pr-7"
          >
            <option value="">Toutes catégories</option>
            {categories.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <Filter className="h-4 w-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>

        <div className="relative min-w-[150px]">
          <select
            value={serviceFilter}
            onChange={e => setServiceFilter(e.target.value)}
            className="w-full py-2 px-3 bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-white/10 transition-all text-xs outline-none appearance-none pr-7"
          >
            <option value="">Tous services</option>
            {serviceGroups.map(g => (
              <optgroup key={g.id} label={g.name}>
                {g.services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </optgroup>
            ))}
          </select>
          <Filter className="h-4 w-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>

        {isSuperAdmin && (
          <div className="relative min-w-[170px]">
            <select
              value={provinceFilter}
              onChange={(e) => setProvinceFilter(e.target.value)}
              className="w-full bg-gradient-to-r from-slate-100 to-slate-50 dark:from-white/5 dark:to-white/[0.03] border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-white outline-none appearance-none pr-7 shadow-sm"
            >
              <option>Toutes provinces</option>
              <option>Kinshasa</option>
              <option>Kwilu</option>
              <option>Kasaï</option>
              <option>Kasaï Central</option>
            </select>
            <Filter className="h-4 w-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        )}

        <div className="flex items-center gap-1.5 min-w-[180px]">
          <label className="text-[10px] font-semibold text-slate-600 dark:text-slate-400">Du</label>
          <input
            type="date"
            value={dateRangeStart}
            onChange={e => setDateRangeStart(e.target.value)}
            className="px-2 py-1.5 bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-md text-[11px] text-slate-900 dark:text-white outline-none focus:border-slate-400 dark:focus:border-white/30 transition-all"
          />
        </div>

        <div className="flex items-center gap-1.5 min-w-[180px]">
          <label className="text-[10px] font-semibold text-slate-600 dark:text-slate-400">Au</label>
          <input
            type="date"
            value={dateRangeEnd}
            onChange={e => setDateRangeEnd(e.target.value)}
            className="px-2 py-1.5 bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-md text-[11px] text-slate-900 dark:text-white outline-none focus:border-slate-400 dark:focus:border-white/30 transition-all"
          />
        </div>

        <button
          onClick={resetFilters}
          className="px-2.5 py-1.5 text-[11px] font-semibold bg-slate-200 dark:bg-white/10 hover:bg-slate-300 dark:hover:bg-white/20 text-slate-900 dark:text-white rounded-md transition-all"
        >
          Reset
        </button>

        <div className="flex gap-1.5 ml-auto">
          <button
            onClick={handleExportPDF}
            title="Exporter en PDF"
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 rounded-md transition-all border border-red-500/20 dark:border-red-500/30"
          >
            <Download className="h-3 w-3" /> PDF
          </button>
          <button
            onClick={handleExportExcel}
            title="Exporter en Excel"
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold bg-green-500/10 hover:bg-green-500/20 text-green-600 dark:text-green-400 rounded-md transition-all border border-green-500/20 dark:border-green-500/30"
          >
            <Download className="h-3 w-3" /> Excel
          </button>
        </div>
      </div>
      )}

      {selectedIds.size > 0 && (
        <div className="flex flex-col sm:flex-row gap-3 items-center bg-blue-500/10 border border-blue-500/20 rounded-lg p-3">
          <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">
            {selectedIds.size} document{selectedIds.size > 1 ? 's' : ''} sélectionné{selectedIds.size > 1 ? 's' : ''}
          </span>
          <div className="flex gap-2 ml-auto">
            {trashMode ? (
              <>
                <button
                  onClick={handleBatchRestore}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-600/80 text-white rounded-lg transition-all"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Restaurer
                </button>
                <button
                  onClick={handleBatchPermanentDelete}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold bg-red-600 hover:bg-red-600/80 text-white rounded-lg transition-all"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Supprimer définitivement
                </button>
              </>
            ) : (
              <>
            <button
              onClick={handleBatchPrint}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-600/80 text-white rounded-lg transition-all"
            >
              <Printer className="h-3.5 w-3.5" /> Imprimer
            </button>
            <button
              onClick={() => setShareModalOpen(true)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-600/80 text-white rounded-lg transition-all"
            >
              <Share2 className="h-3.5 w-3.5" /> Partager
            </button>
            {canDeleteDocuments && (
              <button
                onClick={handleBatchDelete}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold bg-red-600 hover:bg-red-600/80 text-white rounded-lg transition-all"
              >
                <Trash2 className="h-3.5 w-3.5" /> Supprimer
              </button>
            )}
              </>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto rounded-xl border border-slate-200 dark:border-white/10 bg-white/60 dark:bg-white/[0.03] backdrop-blur-sm">
        <table id="export-table" className="w-full border-collapse text-sm min-w-[900px]">
          <thead className="sticky top-0 z-10">
            <tr className="bg-slate-100/90 dark:bg-white/[0.06] backdrop-blur-sm">
              <th className="text-center text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider px-3 py-3 border-b border-slate-200 dark:border-white/10 w-12">
                <button onClick={toggleSelectAll} className="w-5 h-5 flex items-center justify-center">
                  {selectedIds.size === documents.length && documents.length > 0 ? (
                    <CheckSquare className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  ) : (
                    <Square className="h-4 w-4 text-slate-400" />
                  )}
                </button>
              </th>
              <th className="text-center text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider px-3 py-3 border-b border-l border-slate-200 dark:border-white/10 w-10">N°</th>
              <th className="text-left text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider px-4 py-3 border-b border-l border-slate-200 dark:border-white/10">Document</th>
              <th className="text-left text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider px-4 py-3 border-b border-l border-slate-200 dark:border-white/10">Nature</th>
              <th className="text-left text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider px-4 py-3 border-b border-l border-slate-200 dark:border-white/10">Province</th>
              <th className="text-left text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider px-4 py-3 border-b border-l border-slate-200 dark:border-white/10 hidden sm:table-cell">Service</th>
              <th className="text-left text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider px-4 py-3 border-b border-l border-slate-200 dark:border-white/10 hidden sm:table-cell">Date</th>
              <th className="text-left text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider px-4 py-3 border-b border-l border-slate-200 dark:border-white/10 hidden sm:table-cell">Taille</th>
              <th className="text-right text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider px-4 py-3 border-b border-l border-slate-200 dark:border-white/10">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="py-8">
                  <div className="flex items-center justify-center text-slate-500 gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> Chargement…
                  </div>
                </td>
              </tr>
            )}

            {!loading && documents.length === 0 && (
              <tr>
                <td colSpan={8} className="py-8">
                  <p className="text-slate-500 text-sm text-center">
                    {trashMode
                      ? 'La corbeille est vide.'
                      : "Aucun document archivé pour l'instant. Utilise Scan Direct ou Importation pour en ajouter."}
                  </p>
                </td>
              </tr>
            )}

            {documents.map((doc, index) => (
              <tr
                key={doc.id}
                className="border-b border-slate-200 dark:border-white/10 last:border-b-0 hover:bg-slate-100/70 dark:hover:bg-white/5 transition-colors"
              >
                <td className="px-3 py-3 align-middle text-center w-12">
                  <button onClick={() => toggleSelectId(doc.id)} className="w-5 h-5 flex items-center justify-center mx-auto">
                    {selectedIds.has(doc.id) ? (
                      <CheckSquare className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    ) : (
                      <Square className="h-4 w-4 text-slate-400" />
                    )}
                  </button>
                </td>
                <td className="px-3 py-3 align-middle text-center text-xs text-slate-500 dark:text-slate-400 font-medium border-l border-slate-200 dark:border-white/10 w-10">
                  {index + 1}
                </td>
                <td className="px-4 py-3 align-middle min-w-0 max-w-[280px] border-l border-slate-200 dark:border-white/10">
                  <p className="text-slate-900 dark:text-white text-sm font-medium truncate">{doc.name}</p>
                  {doc.original_name && doc.original_name !== doc.name && (
                    <p
                      className="text-[11px] text-slate-400 dark:text-slate-500 font-mono truncate"
                      title={`Nom du fichier d'origine : ${doc.original_name}`}
                    >
                      {doc.original_name}
                    </p>
                  )}
                  {(doc.sender || doc.subject) && (
                    <p className="text-slate-500 text-[11px] truncate mt-0.5">
                      {doc.sender && <span className="text-slate-500">{doc.sender}</span>}
                      {doc.sender && doc.subject && ' · '}
                      {doc.subject}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 align-middle border-l border-slate-200 dark:border-white/10">
                  <span
                    className="text-xs px-2 py-0.5 rounded-full whitespace-nowrap"
                    style={{ backgroundColor: (doc.categories?.color || '#64748B') + '30', color: doc.categories?.color || '#94a3b8' }}
                  >
                    {doc.categories?.name || doc.doc_type || 'Non classé'}
                  </span>
                  {doc.ai_fields?.nature === 'finance' && (
                    <BadgeConformite compteurs={anomaliesParDoc[doc.id]} className="mt-1 flex w-fit" />
                  )}
                </td>
                <td className="px-4 py-3 align-middle border-l border-slate-200 dark:border-white/10">
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-slate-100 dark:bg-white/5 text-xs font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap max-w-36 truncate">
                    {doc.province || 'Kinshasa'}
                  </span>
                </td>
                <td className="px-4 py-3 align-middle border-l border-slate-200 dark:border-white/10 hidden sm:table-cell">
                  <span className="text-xs text-slate-500 whitespace-nowrap max-w-36 truncate block">
                    {doc.services?.name || '—'}
                  </span>
                </td>
                <td className="px-4 py-3 align-middle border-l border-slate-200 dark:border-white/10 hidden sm:table-cell">
                  <span className="text-xs text-slate-500 whitespace-nowrap">{formatDate(doc)}</span>
                </td>
                <td className="px-4 py-3 align-middle border-l border-slate-200 dark:border-white/10 hidden sm:table-cell">
                  <span className="text-xs text-slate-400 whitespace-nowrap">{formatSize(doc.size_kb)}</span>
                </td>
                <td className="px-4 py-3 align-middle border-l border-slate-200 dark:border-white/10">
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => setPreview(doc)} className="text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors" title="Aperçu">
                      <Eye className="h-4 w-4" />
                    </button>
                    {trashMode ? (
                      <>
                        <button onClick={() => handleRestore(doc)} className="text-slate-400 hover:text-emerald-500 dark:hover:text-emerald-400 transition-colors" title="Restaurer">
                          <RotateCcw className="h-4 w-4" />
                        </button>
                        <button onClick={() => handlePermanentDelete(doc)} className="text-slate-400 hover:text-red-400 transition-colors" title="Supprimer définitivement">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => openChat(doc)} className="text-slate-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors" title="Discuter avec l'IA">
                          <MessageCircle className="h-4 w-4" />
                        </button>
                        {canDeleteDocuments && (
                          <button onClick={() => handleDelete(doc)} className="text-slate-400 hover:text-red-400 transition-colors" title="Mettre à la corbeille">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6" onClick={() => setPreview(null)}>
          <div
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-white/10 rounded-2xl p-6 max-w-2xl w-full max-h-[80vh] overflow-auto flex flex-col gap-4 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <h3 className="text-slate-900 dark:text-white font-bold text-lg truncate">{preview.name}</h3>
                {preview.original_name && preview.original_name !== preview.name && (
                  <p className="text-xs text-slate-400 dark:text-slate-500 font-mono truncate">
                    Fichier d'origine : {preview.original_name}
                  </p>
                )}
              </div>
              <button onClick={() => setPreview(null)} className="text-slate-400 hover:text-slate-900 dark:hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-slate-500">
              <span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/5">{preview.categories?.name || preview.doc_type || 'Non classé'}</span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/5">{preview.province || 'Kinshasa'}</span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/5">{formatDate(preview)}</span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/5">{formatSize(preview.size_kb)}</span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/5">{preview.page_count} page(s)</span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/5 capitalize">Source : {preview.source}</span>
            </div>

            {preview.ai_fields?.nature === 'finance' && (
              <AnomaliesLiasse
                documentId={preview.id}
                fields={preview.ai_fields}
                userId={session?.id || null}
                compact
              />
            )}

            {preview.file_url && (
              <div className="flex gap-1.5 border-b border-slate-200 dark:border-white/10">
                <button
                  onClick={() => setPreviewTab('resume')}
                  className={`px-3 py-2 text-xs font-semibold border-b-2 transition-colors ${
                    previewTab === 'resume'
                      ? 'border-[#7AC143] text-[#7AC143]'
                      : 'border-transparent text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                  }`}
                >
                  Résumé IA
                </button>
                <button
                  onClick={() => setPreviewTab('document')}
                  className={`px-3 py-2 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
                    previewTab === 'document'
                      ? 'border-[#7AC143] text-[#7AC143]'
                      : 'border-transparent text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                  }`}
                >
                  <FileImage className="h-3.5 w-3.5" /> Document scanné
                </button>
              </div>
            )}

            {previewTab === 'document' && preview.file_url ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => setDocZoom(z => Math.max(0.25, +(z - 0.25).toFixed(2)))} className="p-1.5 rounded-lg bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/20 text-slate-600 dark:text-slate-200" title="Zoom arrière">
                      <ZoomOut className="h-4 w-4" />
                    </button>
                    <span className="text-xs text-slate-500 w-12 text-center">{Math.round(docZoom * 100)}%</span>
                    <button onClick={() => setDocZoom(z => Math.min(3, +(z + 0.25).toFixed(2)))} className="p-1.5 rounded-lg bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/20 text-slate-600 dark:text-slate-200" title="Zoom avant">
                      <ZoomIn className="h-4 w-4" />
                    </button>
                    {!isPdfFile(preview.file_url) && (
                      <button onClick={() => setDocRotation(r => (r + 90) % 360)} className="p-1.5 rounded-lg bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/20 text-slate-600 dark:text-slate-200" title="Pivoter">
                        <RotateCw className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <button
                    onClick={printPreviewFile}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#92278F] hover:bg-[#92278F]/80 text-white text-xs font-semibold transition-all"
                  >
                    <Printer className="h-3.5 w-3.5" /> Imprimer la pièce
                  </button>
                </div>

                <div className="bg-slate-200/50 dark:bg-slate-950/40 rounded-xl overflow-auto max-h-[50vh] flex items-center justify-center p-3">
                  {!fichierSigne ? (
                    <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin" /> Ouverture sécurisée de la pièce…
                    </div>
                  ) : isPdfFile(preview.file_url) ? (
                    <iframe
                      src={fichierSigne}
                      title={preview.name}
                      style={{ width: `${docZoom * 100}%`, minHeight: '60vh' }}
                      className="bg-white rounded shadow-lg border-0"
                    />
                  ) : (
                    <img
                      src={fichierSigne}
                      alt={`Pièce scannée — ${preview.name}`}
                      style={{ transform: `scale(${docZoom}) rotate(${docRotation}deg)`, transition: 'transform 0.2s ease' }}
                      className="rounded shadow-lg max-w-full h-auto"
                    />
                  )}
                </div>
              </div>
            ) : (
              <>
                {(preview.sender || preview.subject || preview.services?.name) && (
                  <div className="bg-slate-100/80 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-3 flex flex-col gap-1.5 text-sm">
                    {preview.sender && (
                      <p className="text-slate-700 dark:text-slate-300"><span className="text-slate-400 text-xs uppercase tracking-wide mr-2">Expéditeur / Auteur</span>{preview.sender}</p>
                    )}
                    {preview.subject && (
                      <p className="text-slate-700 dark:text-slate-300"><span className="text-slate-400 text-xs uppercase tracking-wide mr-2">Objet</span>{preview.subject}</p>
                    )}
                    {preview.services?.name && (
                      <p className="text-slate-700 dark:text-slate-300"><span className="text-slate-400 text-xs uppercase tracking-wide mr-2">Service concerné</span>{preview.services.name}</p>
                    )}
                  </div>
                )}

                {preview.ai_summary && (
                  <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-3">
                    <p className="text-blue-600 dark:text-blue-300 text-xs font-semibold mb-1 flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5" /> Résumé IA
                    </p>
                    <p className="text-slate-700 dark:text-slate-300 text-sm">{preview.ai_summary}</p>
                    {preview.ai_tags?.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {preview.ai_tags.map(tag => (
                          <span key={tag} className="text-[11px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-300">{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="bg-slate-100/50 dark:bg-black/20 rounded-xl p-3 text-slate-600 dark:text-slate-300 text-xs whitespace-pre-wrap font-mono max-h-64 overflow-auto">
                  {preview.content_text || 'Aucun contenu texte disponible pour ce document.'}
                </div>
              </>
            )}

            <button
              onClick={() => { openChat(preview); setPreview(null); }}
              className="bg-blue-600 hover:bg-blue-600/80 text-white py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all"
            >
              <MessageCircle className="h-4 w-4" /> Discuter de ce document avec l'IA
            </button>
          </div>
        </div>
      )}

      {shareModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6" onClick={() => setShareModalOpen(false)}>
          <div
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-white/10 rounded-2xl p-6 max-w-md w-full shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <h3 className="text-slate-900 dark:text-white font-bold text-lg">Partager en masse</h3>
              <button onClick={() => setShareModalOpen(false)} className="ml-auto text-slate-400 hover:text-slate-900 dark:hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-2">Adresses email</label>
                {shareEmails.map((email, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <input
                      type="email"
                      value={email}
                      onChange={e => {
                        const newEmails = [...shareEmails];
                        newEmails[i] = e.target.value;
                        setShareEmails(newEmails);
                      }}
                      placeholder="user@example.com"
                      className="flex-1 px-3 py-2 bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg text-sm text-slate-900 dark:text-white outline-none focus:border-slate-400 dark:focus:border-white/30 transition-all"
                    />
                    {shareEmails.length > 1 && (
                      <button
                        onClick={() => setShareEmails(shareEmails.filter((_, idx) => idx !== i))}
                        className="px-2 py-2 text-red-600 dark:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
                <button
                  onClick={() => setShareEmails([...shareEmails, ''])}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-semibold mt-2"
                >
                  + Ajouter email
                </button>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-2">Accès</label>
                <select
                  value={shareAccessLevel}
                  onChange={e => setShareAccessLevel(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg text-sm text-slate-900 dark:text-white outline-none focus:border-slate-400 dark:focus:border-white/30 transition-all"
                >
                  <option value="Lecture">Lecture seule</option>
                  <option value="Modification">Modification</option>
                </select>
              </div>

              <div className="flex gap-2 justify-end pt-4 border-t border-slate-200 dark:border-white/10">
                <button
                  onClick={() => setShareModalOpen(false)}
                  className="px-4 py-2 text-xs font-semibold bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/20 text-slate-900 dark:text-white rounded-lg transition-all"
                >
                  Annuler
                </button>
                <button
                  onClick={handleBatchShare}
                  className="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-600/80 text-white rounded-lg transition-all"
                >
                  Partager
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
