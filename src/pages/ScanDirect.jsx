import React, { useEffect, useState } from 'react';
import {
  ScanTextIcon, Play, RotateCcw, Sparkles, Loader2, CheckCircle2,
  FileText, Tag, Calendar, FolderKanban, Save, User, ClipboardList, Building2,
  ChevronLeft, ChevronRight, RotateCw, ZoomIn, ZoomOut, Copy, Check, PencilLine,
} from 'lucide-react';
import { generateScannedDocument, generateFakePagePreview } from '../services/scanSimulator';
import { detectScannerBridge, listScanners, scanWithBridge, getDefaultScannerId } from '../services/scannerBridgeService';
import { summarizeDocument } from '../services/aiAgentService';
import { listCategories } from '../services/categoriesService';
import { listServiceGroups, listServices } from '../services/servicesService';
import { createDocument } from '../services/documentsService';
import { logActivity } from '../services/activityLogService';
import { uploadDocumentFile, dataUrlToBlob } from '../services/storageService';
import { useSession } from '../context/SessionContext';

function parseFrenchDate(value) {
  if (!value) return null;
  const m = value.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return null;
}

export default function ScanDirect({ onBack }) {
  const { session } = useSession();
  const [resolution, setResolution] = useState('300');
  const [pageSize, setPageSize] = useState('A4');
  const [colorMode, setColorMode] = useState('Couleur');

  const [step, setStep] = useState('idle');
  const [scanData, setScanData] = useState(null);
  const [aiResult, setAiResult] = useState(null);
  const [categories, setCategories] = useState([]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const EMPTY_FORM = { title: '', categoryId: '', serviceId: '', docDate: '', sender: '', subject: '', tags: '', summary: '' };
  const [form, setForm] = useState(EMPTY_FORM);
  const [serviceGroups, setServiceGroups] = useState([]);
  const [services, setServices] = useState([]);
  const [previewPage, setPreviewPage] = useState(0);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [copied, setCopied] = useState(false);
  const metadataReady = React.useRef(null);

  const [bridgeStatus, setBridgeStatus] = useState('checking');
  const [devices, setDevices] = useState([]);

  const probeBridge = async () => {
    setBridgeStatus('checking');
    const bridge = await detectScannerBridge();
    if (!bridge) {
      setBridgeStatus('no-bridge');
      setDevices([]);
      return;
    }
    try {
      const scanners = await listScanners();
      if (scanners.length === 0) {
        setBridgeStatus('no-scanner');
        setDevices([]);
      } else {
        setBridgeStatus('ready');
        setDevices(scanners);
      }
    } catch {
      setBridgeStatus('no-scanner');
      setDevices([]);
    }
  };

  useEffect(() => {
    metadataReady.current = Promise.all([listCategories(), listServiceGroups(), listServices()]);
    metadataReady.current
      .then(([loadedCategories, loadedServiceGroups, loadedServices]) => {
        setCategories(loadedCategories);
        setServiceGroups(loadedServiceGroups);
        setServices(loadedServices);
      })
      .catch(err => setError(err.message));
    probeBridge();
  }, []);

  const handleScan = async () => {
    setError(null);
    setStep('scanning');

    if (bridgeStatus === 'ready') {
      try {
        const preferred = getDefaultScannerId();
        const device = devices.find(d => d.deviceId === preferred) || devices[0];
        const result = await scanWithBridge({ dpi: resolution, colorMode, deviceId: device?.deviceId, pageSize });
        const now = new Date();
        const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1_$2');
        const pages = result.pages?.length ? result.pages : [{ image: result.image, sizeKb: result.sizeKb }];
        setScanData({
          fileName: `Scan_${stamp}.jpg`,
          docType: 'Document scanné',
          contentText: '',
          pageCount: result.pageCount || pages.length,
          sizeKb: result.sizeKb,
          previewSvg: pages[0].image,
          pages: pages.map(p => p.image),
          imageBase64: pages[0].image.split(',')[1],
          imagesBase64: pages.slice(0, 8).map(p => p.image.split(',')[1]),
          imageMediaType: result.mediaType,
          real: true,
          deviceName: result.deviceName,
        });
        setPreviewPage(0);
        setStep('scanned');
      } catch (err) {
        setError(`Scan réel impossible : ${err.message}`);
        setStep('idle');
      }
      return;
    }

    setTimeout(() => {
      const doc = generateScannedDocument();
      setScanData({ ...doc, previewSvg: generateFakePagePreview(doc.docType) });
      setStep('scanned');
    }, 1400);
  };

  const handleAnalyze = async () => {
    setError(null);
    setStep('analyzing');
    try {
      const [loadedCategories, , loadedServices] = await (metadataReady.current || Promise.all([listCategories(), listServiceGroups(), listServices()]));
      const result = await summarizeDocument({
        fileName: scanData.fileName,
        docType: scanData.docType,
        contentText: scanData.contentText,
        imageBase64: scanData.imageBase64,
        imagesBase64: scanData.imagesBase64,
        imageMediaType: scanData.imageMediaType,
        categories: loadedCategories.map(c => c.name),
        services: loadedServices.map(s => s.name),
      });
      setAiResult(result);
      if (result.extractedText && !scanData.contentText) {
        setScanData(d => ({ ...d, contentText: result.extractedText }));
      }
      const norm = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
      const matchedCategory = loadedCategories.find(c => norm(c.name) === norm(result.category));
      const matchedService = loadedServices.find(s => norm(s.name) === norm(result.serviceName));
      setForm({
        title: result.title || scanData.fileName.replace(/\.[^.]+$/, ''),
        categoryId: matchedCategory ? matchedCategory.id : '',
        serviceId: matchedService ? matchedService.id : '',
        docDate: parseFrenchDate(result.docDate) || '',
        sender: result.sender || '',
        subject: result.subject || '',
        tags: (result.tags || []).join(', '),
        summary: result.summary || '',
      });
      setStep('review');
    } catch (err) {
      setError(err.message || "Échec de l'analyse IA");
      setStep('scanned');
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      let fileUrl = null;
      try {
        const coverImage = scanData.pages?.[0] || scanData.previewSvg;
        if (coverImage && coverImage.startsWith('data:')) {
          const blob = dataUrlToBlob(coverImage);
          fileUrl = await uploadDocumentFile(blob, `${scanData.fileName.replace(/\.[^.]+$/, '')}.jpg`, session?.province);
        }
      } catch {
        fileUrl = null; // l'archivage se poursuit même si l'upload de la pièce échoue
      }

      const newDoc = await createDocument({
        name: form.title || scanData.fileName,
        original_name: scanData.fileName,
        category_id: form.categoryId || null,
        doc_type: scanData.docType,
        source: 'scan',
        province: session?.province || 'Kinshasa',
        status: 'archived',
        size_kb: scanData.sizeKb,
        page_count: scanData.pageCount,
        content_text: scanData.contentText,
        file_url: fileUrl,
        ai_summary: form.summary,
        ai_tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
        ai_confidence: aiResult?.confidence ?? null,
        doc_date: form.docDate || null,
        sender: form.sender || null,
        subject: form.subject || null,
        service_id: form.serviceId || null,
      });
      await logActivity({ documentId: newDoc.id, action: 'scan', detail: `Scan direct · ${scanData.docType}` });
      if (aiResult) {
        await logActivity({
          documentId: newDoc.id,
          action: 'ai_summary',
          detail: aiResult.demo ? 'Résumé généré (mode démo, sans clé IA)' : 'Résumé généré par Claude',
        });
      }
      setStep('saved');
    } catch (err) {
      setError(err.message || "Échec de l'enregistrement");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setStep('idle');
    setScanData(null);
    setAiResult(null);
    setForm(EMPTY_FORM);
    setPreviewPage(0);
    setPreviewZoom(1);
    setError(null);
  };

  const handleManual = () => {
    setAiResult(null);
    setForm({ ...EMPTY_FORM, title: scanData.fileName.replace(/\.[^.]+$/, '') });
    setStep('review');
  };

  const rotateCurrentPage = () => {
    const src = scanData.pages?.[previewPage] || scanData.previewSvg;
    if (!src) return;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.height;
      canvas.height = img.width;
      const ctx = canvas.getContext('2d');
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      const rotated = canvas.toDataURL('image/jpeg', 0.9);
      setScanData(d => {
        const pages = [...(d.pages || [d.previewSvg])];
        pages[previewPage] = rotated;
        const imagesBase64 = pages.slice(0, 8).map(p => p.split(',')[1]);
        return { ...d, pages, previewSvg: pages[0], imageBase64: imagesBase64[0], imagesBase64 };
      });
    };
    img.src = src;
  };

  const copyText = async () => {
    if (!scanData?.contentText) return;
    await navigator.clipboard.writeText(scanData.contentText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const renderPreview = (maxHClass) => {
    const pages = scanData.pages?.length ? scanData.pages : [scanData.previewSvg];
    const toolBtn = 'p-1.5 rounded-lg bg-slate-200 dark:bg-white/10 hover:bg-slate-300 dark:hover:bg-white/20 disabled:opacity-30 text-slate-600 dark:text-slate-200 transition-all';
    return (
      <div className="flex flex-col items-center gap-2 w-full">
        <div className={`w-full overflow-auto ${maxHClass} rounded-lg bg-slate-200/50 dark:bg-slate-950/40 flex ${previewZoom <= 1 ? 'justify-center' : 'justify-start'} p-2`}>
          <img
            src={pages[previewPage] || pages[0]}
            alt={`Aperçu — page ${previewPage + 1}`}
            style={{ width: `${previewZoom * 100}%`, maxWidth: 'none', height: 'auto' }}
            className="rounded shadow-lg self-start"
          />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 text-slate-500 dark:text-slate-300 text-xs">
          {pages.length > 1 && (
            <span className="flex items-center gap-2">
              <button onClick={() => setPreviewPage(p => Math.max(0, p - 1))} disabled={previewPage === 0} className={toolBtn} title="Page précédente">
                <ChevronLeft className="h-4 w-4" />
              </button>
              Page {previewPage + 1} / {pages.length}
              <button onClick={() => setPreviewPage(p => Math.min(pages.length - 1, p + 1))} disabled={previewPage >= pages.length - 1} className={toolBtn} title="Page suivante">
                <ChevronRight className="h-4 w-4" />
              </button>
              <span className="text-slate-400">·</span>
            </span>
          )}
          {scanData.real && (
            <button onClick={rotateCurrentPage} className={toolBtn} title="Pivoter la page de 90°">
              <RotateCw className="h-4 w-4" />
            </button>
          )}
          <button onClick={() => setPreviewZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))} disabled={previewZoom <= 0.5} className={toolBtn} title="Zoom arrière">
            <ZoomOut className="h-4 w-4" />
          </button>
          <button onClick={() => setPreviewZoom(1)} className="px-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white transition-colors" title="Réinitialiser le zoom">
            {Math.round(previewZoom * 100)}%
          </button>
          <button onClick={() => setPreviewZoom(z => Math.min(3, +(z + 0.25).toFixed(2)))} disabled={previewZoom >= 3} className={toolBtn} title="Zoom avant">
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            onClick={copyText}
            disabled={!scanData.contentText}
            className={toolBtn}
            title={scanData.contentText ? 'Copier le texte extrait' : "Texte disponible après l'analyse IA"}
          >
            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex items-center gap-4">
        <div className="p-3 rounded-xl bg-[#D91B5C]">
          <ScanTextIcon className="h-6 w-6 text-white" strokeWidth={1.5} />
        </div>
        <div>
          <h2 className="text-xl md:text-2xl font-bold text-slate-900 dark:text-white tracking-wide">Scan Direct</h2>
          <p className="text-slate-500 text-sm">Connexion scanner · Prêt</p>
        </div>
        <button
          onClick={onBack}
          className="ml-auto px-4 py-2 bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/20 border border-slate-200 dark:border-white/10 rounded-xl text-xs font-semibold text-slate-900 dark:text-white transition-all"
        >
          ← Accueil
        </button>
      </div>

      <hr className="border-slate-200 dark:border-white/10" />

      {bridgeStatus === 'ready' ? (
        <div className="flex items-center gap-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></div>
          <span className="text-emerald-600 dark:text-emerald-300 text-sm font-medium">
            Scanner connecté · {(devices.find(d => d.deviceId === getDefaultScannerId()) || devices[0])?.name || 'Scanner WIA'}
            {devices.length > 1 && <span className="text-emerald-500/70 dark:text-emerald-400/60"> (+{devices.length - 1} autre{devices.length > 2 ? 's' : ''})</span>}
          </span>
          <button onClick={probeBridge} className="ml-auto text-[11px] text-emerald-500/70 hover:text-emerald-600 dark:text-emerald-400/70 dark:hover:text-emerald-300 underline">
            Actualiser
          </button>
        </div>
      ) : bridgeStatus === 'no-scanner' ? (
        <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
          <div className="w-2 h-2 rounded-full bg-amber-400"></div>
          <span className="text-amber-600 dark:text-amber-300 text-sm font-medium">
            Pont de scan actif · aucun scanner détecté — branchez et allumez le scanner
          </span>
          <button onClick={probeBridge} className="ml-auto text-[11px] text-amber-500/70 hover:text-amber-600 dark:text-amber-400/70 dark:hover:text-amber-300 underline">
            Actualiser
          </button>
        </div>
      ) : bridgeStatus === 'checking' ? (
        <div className="flex items-center gap-3 bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-4">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
          <span className="text-slate-500 text-sm font-medium">Recherche du scanner…</span>
        </div>
      ) : (
        <div className="flex items-center gap-3 bg-slate-100/80 dark:bg-slate-500/10 border border-slate-200 dark:border-white/10 rounded-xl p-4">
          <div className="w-2 h-2 rounded-full bg-slate-400"></div>
          <span className="text-slate-600 dark:text-slate-300 text-sm font-medium">
            Mode simulation — lancez le pont de scan (<code className="text-slate-700 dark:text-slate-200">npm run scan-bridge</code>) pour utiliser un vrai scanner
          </span>
          <button onClick={probeBridge} className="ml-auto text-[11px] text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline">
            Actualiser
          </button>
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-red-600 dark:text-red-300 text-sm">{error}</div>
      )}

      {(step === 'idle' || step === 'scanning') && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
            <div className="bg-slate-100/80 dark:bg-white/5 rounded-xl p-4 border border-slate-200 dark:border-white/10">
              <p className="text-slate-500 text-xs mb-2 font-medium">Résolution (DPI)</p>
              <select
                value={resolution}
                onChange={e => setResolution(e.target.value)}
                className="w-full bg-slate-100 dark:bg-white/10 text-slate-900 dark:text-white rounded-lg px-3 py-2 text-sm border border-slate-200 dark:border-white/10 outline-none"
              >
                <option value="150">150</option>
                <option value="300">300</option>
                <option value="600">600</option>
              </select>
            </div>
            <div className="bg-slate-100/80 dark:bg-white/5 rounded-xl p-4 border border-slate-200 dark:border-white/10">
              <p className="text-slate-500 text-xs mb-2 font-medium">Format papier</p>
              <select
                value={pageSize}
                onChange={e => setPageSize(e.target.value)}
                className="w-full bg-slate-100 dark:bg-white/10 text-slate-900 dark:text-white rounded-lg px-3 py-2 text-sm border border-slate-200 dark:border-white/10 outline-none"
              >
                <option value="A4">A4 (210 × 297 mm)</option>
                <option value="Letter">Letter (8,5 × 11 po)</option>
                <option value="Legal">Legal (8,5 × 14 po)</option>
                <option value="Auto">Pleine vitre (auto)</option>
              </select>
            </div>
            <div className="bg-slate-100/80 dark:bg-white/5 rounded-xl p-4 border border-slate-200 dark:border-white/10">
              <p className="text-slate-500 text-xs mb-2 font-medium">Mode couleur</p>
              <select
                value={colorMode}
                onChange={e => setColorMode(e.target.value)}
                className="w-full bg-slate-100 dark:bg-white/10 text-slate-900 dark:text-white rounded-lg px-3 py-2 text-sm border border-slate-200 dark:border-white/10 outline-none"
              >
                <option>Couleur</option>
                <option>Niveaux de gris</option>
                <option>Noir et blanc</option>
              </select>
            </div>
          </div>

          <div className="flex-1 bg-slate-100/50 dark:bg-white/5 rounded-xl border-2 border-dashed border-slate-300 dark:border-white/10 flex items-center justify-center min-h-32">
            {step === 'scanning' ? (
              <div className="flex flex-col items-center gap-3 text-slate-600 dark:text-slate-300">
                <Loader2 className="h-8 w-8 animate-spin text-[#D91B5C]" />
                <p className="text-sm">Numérisation en cours ({resolution} DPI · {pageSize} · {colorMode})…</p>
              </div>
            ) : (
              <p className="text-slate-400 text-sm text-center">
                Zone d'aperçu<br />Placez votre document dans le scanner
              </p>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleScan}
              disabled={step === 'scanning'}
              className="flex-1 bg-[#D91B5C] hover:bg-[#D91B5C]/80 disabled:opacity-50 text-white py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all"
            >
              <Play className="h-4 w-4" /> Lancer le scan
            </button>
            <button className="px-5 bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/20 text-slate-900 dark:text-white py-3 rounded-xl text-sm border border-slate-200 dark:border-white/10 flex items-center gap-2 transition-all">
              <RotateCcw className="h-4 w-4" />
            </button>
          </div>
        </>
      )}

      {(step === 'scanned' || step === 'analyzing') && scanData && (
        <div className="flex-1 flex flex-col gap-4 overflow-auto">
          <div className="grid grid-cols-1 md:grid-cols-[minmax(300px,1fr)_1fr] gap-4 flex-1">
            <div className="bg-slate-100/80 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-3 flex flex-col items-center justify-center gap-2">
              {renderPreview('max-h-[55vh]')}
            </div>
            <div className="bg-slate-100/80 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-4 flex flex-col gap-2">
              <p className="text-slate-900 dark:text-white text-sm font-semibold flex items-center gap-2">
                <FileText className="h-4 w-4 text-[#D91B5C]" /> {scanData.fileName}
              </p>
              <p className="text-slate-500 text-xs">{scanData.pageCount} page(s) · {scanData.sizeKb} Ko · Type détecté : {scanData.docType}</p>
              <div className="mt-2 bg-slate-200/50 dark:bg-black/20 rounded-lg p-3 text-slate-600 dark:text-slate-300 text-xs whitespace-pre-wrap max-h-48 overflow-auto font-mono">
                {scanData.contentText || (scanData.real
                  ? "Document numérisé. Le texte sera lu par l'agent IA lors de l'analyse (bouton ci-dessous)."
                  : scanData.contentText)}
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={handleAnalyze}
              disabled={step === 'analyzing'}
              className="flex-1 bg-blue-600 hover:bg-blue-600/80 disabled:opacity-50 text-white py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all"
            >
              {step === 'analyzing' ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Analyse par l'agent IA…</>
              ) : (
                <><Sparkles className="h-4 w-4" /> Analyser avec l'IA</>
              )}
            </button>
            <button
              onClick={handleManual}
              disabled={step === 'analyzing'}
              className="flex-1 bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/20 disabled:opacity-50 text-slate-900 dark:text-white py-3 rounded-xl font-semibold text-sm border border-slate-200 dark:border-white/10 flex items-center justify-center gap-2 transition-all"
            >
              <PencilLine className="h-4 w-4" /> Compléter manuellement
            </button>
            <button
              onClick={handleReset}
              className="px-5 bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/20 text-slate-900 dark:text-white py-3 rounded-xl text-sm border border-slate-200 dark:border-white/10 transition-all"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {step === 'review' && scanData && (
        <div className="flex-1 flex flex-col gap-4 overflow-auto">
          <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-4 flex-1">
            <div className="bg-slate-100/80 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-4 flex flex-col gap-3 overflow-auto">
              {renderPreview('max-h-[45vh]')}

              {aiResult ? (
                <>
                  <p className="text-slate-900 dark:text-white text-sm font-semibold flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-blue-500 dark:text-blue-400" /> Résumé généré par l'IA
                    {aiResult.demo && (
                      <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-300">
                        {aiResult.fallbackReason ? 'IA indisponible — analyse locale' : 'Mode démo'}
                      </span>
                    )}
                  </p>
                  {aiResult.fallbackReason && (
                    <p className="text-amber-600 dark:text-amber-300 text-xs bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5">
                      ⚠ L'analyse IA a échoué (API inaccessible ou crédit épuisé) : les champs ont été remplis
                      par une analyse locale simplifiée. Vérifiez-les attentivement avant d'enregistrer.
                    </p>
                  )}
                  <p className="text-slate-600 dark:text-slate-300 text-sm leading-relaxed">{form.summary}</p>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {form.tags.split(',').map(t => t.trim()).filter(Boolean).map(tag => (
                      <span key={tag} className="text-[11px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-300">{tag}</span>
                    ))}
                  </div>
                  <p className="text-slate-500 text-xs mt-auto">
                    Confiance de l'analyse : {Math.round((aiResult.confidence ?? 0) * 100)}%
                  </p>
                  <div className="bg-slate-200/50 dark:bg-black/20 rounded-lg p-3 text-slate-500 dark:text-slate-400 text-xs whitespace-pre-wrap max-h-40 overflow-auto font-mono">
                    {scanData.contentText}
                  </div>
                </>
              ) : (
                <div className="bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg p-3 flex flex-col gap-2">
                  <p className="text-slate-600 dark:text-slate-300 text-sm flex items-center gap-2">
                    <PencilLine className="h-4 w-4 text-slate-400" /> Saisie manuelle — remplissez la fiche à droite.
                  </p>
                  <button
                    onClick={handleAnalyze}
                    className="self-start flex items-center gap-2 bg-blue-600/80 hover:bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                  >
                    <Sparkles className="h-3.5 w-3.5" /> Laisser l'IA pré-remplir quand même
                  </button>
                </div>
              )}
            </div>

            <div className="bg-slate-100/80 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-4 flex flex-col gap-3 overflow-auto">
              <p className="text-slate-900 dark:text-white text-sm font-semibold flex items-center gap-2">
                <Save className="h-4 w-4 text-emerald-500 dark:text-emerald-400" /> Fiche d'enregistrement (pré-remplie)
              </p>

              <label className="flex flex-col gap-1">
                <span className="text-slate-500 text-xs font-medium">Titre du document</span>
                <input
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  className="bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white outline-none focus:border-blue-500/60"
                />
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-slate-500 text-xs font-medium flex items-center gap-1"><Calendar className="h-3.5 w-3.5" /> Date du document</span>
                  <input
                    type="date"
                    value={form.docDate}
                    onChange={e => setForm(f => ({ ...f, docDate: e.target.value }))}
                    className="bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white outline-none"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-slate-500 text-xs font-medium flex items-center gap-1"><User className="h-3.5 w-3.5" /> Expéditeur / Auteur</span>
                  <input
                    value={form.sender}
                    onChange={e => setForm(f => ({ ...f, sender: e.target.value }))}
                    className="bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white outline-none"
                  />
                </label>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-slate-500 text-xs font-medium flex items-center gap-1"><ClipboardList className="h-3.5 w-3.5" /> Objet</span>
                <input
                  value={form.subject}
                  onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                  className="bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white outline-none"
                />
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-slate-500 text-xs font-medium flex items-center gap-1"><FolderKanban className="h-3.5 w-3.5" /> Nature</span>
                  <select
                    value={form.categoryId}
                    onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}
                    className="bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white outline-none"
                  >
                    <option value="">Non classé</option>
                    {categories.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-slate-500 text-xs font-medium flex items-center gap-1"><Building2 className="h-3.5 w-3.5" /> Service concerné</span>
                  <select
                    value={form.serviceId}
                    onChange={e => setForm(f => ({ ...f, serviceId: e.target.value }))}
                    className="bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white outline-none"
                  >
                    <option value="">Non affecté</option>
                    {serviceGroups.map(g => (
                      <optgroup key={g.id} label={g.name}>
                        {g.services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </label>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-slate-500 text-xs font-medium flex items-center gap-1"><Tag className="h-3.5 w-3.5" /> Mots-clés</span>
                <input
                  value={form.tags}
                  onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
                  className="bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white outline-none"
                />
              </label>

              <label className="flex flex-col gap-1 flex-1">
                <span className="text-slate-500 text-xs font-medium">Résumé (modifiable)</span>
                <textarea
                  value={form.summary}
                  onChange={e => setForm(f => ({ ...f, summary: e.target.value }))}
                  rows={3}
                  className="bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white outline-none resize-none"
                />
              </label>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 bg-emerald-600 hover:bg-emerald-600/80 disabled:opacity-50 text-white py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Enregistrer dans les archives
            </button>
            <button
              onClick={handleReset}
              className="px-5 bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/20 text-slate-900 dark:text-white py-3 rounded-xl text-sm border border-slate-200 dark:border-white/10 transition-all"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {step === 'saved' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <CheckCircle2 className="h-14 w-14 text-emerald-400" />
          <p className="text-slate-900 dark:text-white font-semibold">Document archivé avec succès</p>
          <p className="text-slate-500 text-sm text-center max-w-sm">
            « {form.title} » a été enregistré dans la base des données avec ses métadonnées{aiResult ? ' et son résumé IA' : ''}.
          </p>
          <button
            onClick={handleReset}
            className="bg-[#D91B5C] hover:bg-[#D91B5C]/80 text-white px-6 py-3 rounded-xl font-semibold text-sm transition-all"
          >
            Scanner un autre document
          </button>
        </div>
      )}

      <p className="text-slate-400 text-[11px] mt-auto">
        Scan réel : lancez le pont local (<code>npm run scan-bridge</code>) qui pilote le scanner via WIA (Windows).
        Sans pont ou sans scanner branché, le module bascule automatiquement en simulation pour valider le workflow.
      </p>
    </div>
  );
}
