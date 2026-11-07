import React, { useState } from 'react';
import { Calendar, Clock, X, Check } from 'lucide-react';
import { ContentDraft } from '../../types';
import { useApp } from '../../context/AppContext';

interface ScheduleModalProps {
  draft: ContentDraft;
  isOpen: boolean;
  onClose: () => void;
  onScheduledSuccess?: () => void;
}

export const ScheduleModal: React.FC<ScheduleModalProps> = ({
  draft,
  isOpen,
  onClose,
  onScheduledSuccess,
}) => {
  const { scheduleDraft } = useApp();

  // Tomorrow as default date
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const defaultDateStr = tomorrow.toISOString().split('T')[0];

  const [date, setDate] = useState(draft.scheduledDate ? draft.scheduledDate.split('T')[0] : defaultDateStr);
  const [time, setTime] = useState(draft.scheduledDate && draft.scheduledDate.includes('T') ? draft.scheduledDate.split('T')[1].slice(0, 5) : '10:00');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    scheduleDraft(draft.id, date, time);
    setTimeout(() => {
      setIsSubmitting(false);
      onClose();
      if (onScheduledSuccess) onScheduledSuccess();
    }, 200);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2 text-zinc-100 font-semibold text-base">
            <Calendar className="w-4 h-4 text-emerald-400" />
            <span>Schedule to Content Calendar</span>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200 transition-colors p-1 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">Content Project</label>
            <p className="text-sm font-medium text-zinc-200 bg-zinc-950 p-2.5 rounded-lg border border-zinc-800/80 truncate">
              {draft.title}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-zinc-500" />
                <span>Publication Date</span>
              </label>
              <input
                type="date"
                required
                value={date}
                onChange={e => setDate(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-hidden focus:border-emerald-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-zinc-500" />
                <span>Target Time</span>
              </label>
              <input
                type="time"
                required
                value={time}
                onChange={e => setTime(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-hidden focus:border-emerald-500 transition-colors"
              />
            </div>
          </div>

          <div className="p-3 bg-zinc-950/60 rounded-lg border border-zinc-800/60 text-xs text-zinc-400 leading-relaxed">
            <span className="font-medium text-zinc-300">Phase 1 Scheduling State:</span> This assigns the draft to the internal Content Calendar for team review. In Phase 2, this workflow connects to automated platform publishers.
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Confirm Schedule</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
