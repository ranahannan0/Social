import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { authedFetch } from '../../services/authClient';
import {
  VIDEO_MAX_BYTES,
  VIDEO_MIME_TYPES,
  type VideoAnalysis,
} from '../../utils/videoAssets';
import { Film, Upload, Sparkles, Trash2, Check, AlertTriangle, Info, Loader2, Copy } from 'lucide-react';

interface VideoAsset {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  analysis: VideoAnalysis | null;
  analysisIsFallback: boolean | null;
  analyzedAt: string | null;
  createdAt: string;
}

const ACCEPT = VIDEO_MIME_TYPES.join(',');
const STATUS_STYLES: Record<string, string> = {
  uploaded: 'bg-zinc-800 text-zinc-400 border border-zinc-700/80',
  analyzing: 'bg-amber-950 text-amber-400 border border-amber-800/80',
  analyzed: 'bg-emerald-950 text-emerald-400 border border-emerald-800/80',
  failed: 'bg-red-950 text-red-400 border border-red-800/80',
};

function formatSize(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

export const VideoAssetsCard: React.FC = () => {
  const { activeOrgId, activeRole, canWrite } = useApp();
  const [videos, setVideos] = useState<VideoAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [copiedCaptionId, setCopiedCaptionId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canDelete = activeRole === 'owner' || activeRole === 'admin';

  const fetchVideos = useCallback(async () => {
    if (!activeOrgId) {
      setVideos([]);
      return;
    }
    setLoading(true);
    try {
      const res = await authedFetch(`/api/orgs/${activeOrgId}/videos`);
      if (res.ok) {
        const body = await res.json();
        setVideos(Array.isArray(body?.videos) ? body.videos : []);
        setErrorMsg(null);
      } else {
        const body = await res.json().catch(() => null);
        setErrorMsg(body?.message || 'Videos could not be loaded.');
      }
    } catch {
      setErrorMsg('Videos could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => {
    void fetchVideos();
  }, [fetchVideos]);

  const handleFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    setErrorMsg(null);
    setNote(null);
    if (!file || !activeOrgId) return;
    if (!VIDEO_MIME_TYPES.includes(file.type as never)) {
      setErrorMsg('Only MP4, WebM and QuickTime (MOV) videos are supported.');
      return;
    }
    if (file.size > VIDEO_MAX_BYTES) {
      setErrorMsg('Videos are limited to 25 MB.');
      return;
    }
    setUploading(true);
    try {
      const res = await authedFetch(`/api/orgs/${activeOrgId}/videos`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type,
          'x-file-name': encodeURIComponent(file.name),
        },
        body: file,
      });
      if (res.status === 201) {
        await fetchVideos();
      } else {
        const body = await res.json().catch(() => null);
        setErrorMsg(body?.message || 'The upload failed.');
      }
    } catch {
      setErrorMsg('The upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const handleAnalyze = async (video: VideoAsset) => {
    if (!activeOrgId) return;
    setAnalyzingId(video.id);
    setErrorMsg(null);
    setNote(null);
    try {
      const res = await authedFetch(`/api/orgs/${activeOrgId}/videos/${video.id}/analyze`, {
        method: 'POST',
      });
      if (res.ok) {
        const body = await res.json();
        setNote(typeof body?.note === 'string' ? body.note : null);
        await fetchVideos();
      } else {
        const body = await res.json().catch(() => null);
        setErrorMsg(body?.message || 'The analysis failed.');
        await fetchVideos();
      }
    } catch {
      setErrorMsg('The analysis failed.');
    } finally {
      setAnalyzingId(null);
    }
  };

  const handleDelete = async (video: VideoAsset) => {
    if (!activeOrgId) return;
    setErrorMsg(null);
    try {
      const res = await authedFetch(`/api/orgs/${activeOrgId}/videos/${video.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setConfirmDeleteId(null);
        await fetchVideos();
      } else {
        const body = await res.json().catch(() => null);
        setErrorMsg(body?.message || 'The deletion failed.');
        setConfirmDeleteId(null);
      }
    } catch {
      setErrorMsg('The deletion failed.');
    }
  };

  const copyCaption = (video: VideoAsset) => {
    if (video.analysis?.suggestedCaption) {
      void navigator.clipboard.writeText(video.analysis.suggestedCaption);
      setCopiedCaptionId(video.id);
      setTimeout(() => setCopiedCaptionId(null), 2000);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
            <Film className="w-4 h-4 text-emerald-400" />
            <span>Video Assets &amp; AI Analysis</span>
          </h2>
          <p className="text-xs text-zinc-400">
            Upload brand videos (MP4, WebM or MOV, up to 25 MB) and get AI suggestions on hook, pacing, captions and platform fit.
          </p>
        </div>
        {canWrite && activeOrgId && (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={handleFilePicked}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors"
            >
              {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              <span>{uploading ? 'Uploading…' : 'Upload Video'}</span>
            </button>
          </div>
        )}
      </div>

      {errorMsg && (
        <div className="flex items-start gap-2 text-xs text-red-300 bg-red-950/40 border border-red-900/60 rounded-lg p-3">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}
      {note && (
        <div className="flex items-start gap-2 text-xs text-zinc-300 bg-zinc-950 border border-zinc-800 rounded-lg p-3">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-zinc-500" />
          <span>{note}</span>
        </div>
      )}

      {!activeOrgId ? (
        <div className="p-8 text-center bg-zinc-950/40 border border-zinc-800 rounded-lg space-y-1">
          <Film className="w-6 h-6 text-zinc-600 mx-auto" />
          <p className="text-sm text-zinc-300">Videos need a cloud workspace</p>
          <p className="text-xs text-zinc-500">Sign in and pick a workspace to upload and analyze videos.</p>
        </div>
      ) : loading ? (
        <div className="p-6 text-center text-xs text-zinc-500">Loading videos…</div>
      ) : videos.length === 0 ? (
        <div className="p-8 text-center bg-zinc-950/40 border border-zinc-800 rounded-lg space-y-1">
          <Film className="w-6 h-6 text-zinc-600 mx-auto" />
          <p className="text-sm text-zinc-300">No videos yet</p>
          <p className="text-xs text-zinc-500">
            {canWrite ? 'Upload your first brand video to get AI-powered suggestions.' : 'This workspace has no video assets yet.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {videos.map(video => (
            <div key={video.id} className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-zinc-100 truncate">{video.fileName}</h3>
                  <p className="text-xs text-zinc-500">
                    {video.mimeType} · {formatSize(video.sizeBytes)} · {new Date(video.createdAt).toLocaleString()}
                  </p>
                </div>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md shrink-0 ${STATUS_STYLES[video.status] ?? STATUS_STYLES.uploaded}`}>
                  {video.status.toUpperCase()}
                </span>
              </div>

              <div className="flex items-center gap-2">
                {canWrite && (
                  <button
                    onClick={() => void handleAnalyze(video)}
                    disabled={analyzingId === video.id || video.status === 'analyzing'}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60 text-zinc-100 text-xs font-medium rounded-lg border border-zinc-700 transition-colors"
                  >
                    {analyzingId === video.id || video.status === 'analyzing' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                    )}
                    <span>{analyzingId === video.id || video.status === 'analyzing' ? 'Analyzing…' : 'Analyze with AI'}</span>
                  </button>
                )}
                {canDelete && (
                  confirmDeleteId === video.id ? (
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-zinc-400">Delete this video?</span>
                      <button
                        onClick={() => void handleDelete(video)}
                        className="px-2.5 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-semibold rounded-lg transition-colors"
                      >
                        Yes, delete
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(video.id)}
                      className="p-1.5 text-zinc-500 hover:text-red-400 rounded-md hover:bg-zinc-800 transition-colors"
                      title="Delete video"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )
                )}
              </div>

              {video.analysis && (
                <div className="border-t border-zinc-800 pt-3 space-y-3">
                  {video.analysisIsFallback && (
                    <div className="flex items-start gap-2 text-[11px] text-amber-300 bg-amber-950/30 border border-amber-900/50 rounded-lg p-2.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>Heuristic analysis (no live AI) — configure GEMINI_API_KEY for full video viewing.</span>
                    </div>
                  )}
                  <p className="text-xs text-zinc-300 leading-relaxed">{video.analysis.summary}</p>

                  {video.analysis.strengths.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wide">Strengths</p>
                      {video.analysis.strengths.map((s, i) => (
                        <p key={i} className="text-xs text-zinc-300 flex items-start gap-2">
                          <Check className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-500" />
                          <span>{s}</span>
                        </p>
                      ))}
                    </div>
                  )}

                  {video.analysis.improvements.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-semibold text-amber-400 uppercase tracking-wide">Improvements</p>
                      {video.analysis.improvements.map((s, i) => (
                        <p key={i} className="text-xs text-zinc-300 flex items-start gap-2">
                          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />
                          <span>{s}</span>
                        </p>
                      ))}
                    </div>
                  )}

                  {video.analysis.suggestions.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wide">Suggestions</p>
                      {video.analysis.suggestions.map((s, i) => (
                        <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs font-semibold text-zinc-100">{s.title}</p>
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${
                              s.priority === 'high' ? 'bg-red-950 text-red-400 border border-red-800/60'
                              : s.priority === 'medium' ? 'bg-amber-950 text-amber-400 border border-amber-800/60'
                              : 'bg-zinc-800 text-zinc-400 border border-zinc-700/60'
                            }`}>
                              {String(s.priority).toUpperCase()}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-400 leading-relaxed">{s.detail}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {video.analysis.bestPlatforms.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {video.analysis.bestPlatforms.map(p => (
                        <span key={p} className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-emerald-950 text-emerald-400 border border-emerald-800/60">
                          {p}
                        </span>
                      ))}
                    </div>
                  )}

                  {video.analysis.suggestedCaption && (
                    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
                      <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wide">Suggested caption</p>
                      <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">{video.analysis.suggestedCaption}</p>
                      <button
                        onClick={() => copyCaption(video)}
                        className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200"
                      >
                        {copiedCaptionId === video.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        <span>{copiedCaptionId === video.id ? 'Copied' : 'Copy caption'}</span>
                      </button>
                    </div>
                  )}

                  {video.analysis.suggestedHashtags.length > 0 && (
                    <div className="flex flex-wrap gap-1 text-[11px] text-zinc-500 font-mono">
                      {video.analysis.suggestedHashtags.map(t => (
                        <span key={t}>#{t}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
