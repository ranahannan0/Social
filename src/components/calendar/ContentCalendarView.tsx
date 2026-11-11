import React, { useState, useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { CalendarEvent, PlatformType } from '../../types';
import { PLATFORMS_CONFIG } from '../../services/constants';
import { PlatformIcon } from '../common/PlatformIcon';
import { addDays, toLocalDateKey } from '../../utils/dateUtils';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Plus,
  Info,
  Radio,
  X,
  Trash2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';

type CalendarViewMode = 'month' | 'week' | 'day';

export const ContentCalendarView: React.FC = () => {
  const { calendarEvents, addCalendarEvent, deleteCalendarEvent, drafts, brands, activeBrandId, canWrite } = useApp();

  const [viewMode, setViewMode] = useState<CalendarViewMode>('month');
  // Opens on the ACTUAL current date (audit item B-3: was frozen at Nov 2026).
  // Lazy initializer avoids constructing a Date on every render.
  const [currentDate, setCurrentDate] = useState<Date>(() => new Date());

  // Selected event modal
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

  // New Event Modal — default date is tomorrow in LOCAL calendar terms
  // (never toISOString(), which shifts the day across UTC boundaries).
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newEvent, setNewEvent] = useState({
    title: '',
    platform: 'linkedin' as PlatformType,
    date: toLocalDateKey(addDays(new Date(), 1)),
    time: '10:00',
    status: 'scheduled' as 'draft' | 'scheduled',
    summary: '',
    brandId: activeBrandId,
  });

  // Calendar math for month view
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const monthName = currentDate.toLocaleString('default', { month: 'long', year: 'numeric' });

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayIndex = new Date(year, month, 1).getDay(); // 0 is Sun

  const handlePrev = () => {
    if (viewMode === 'month') {
      setCurrentDate(new Date(year, month - 1, 1));
    } else if (viewMode === 'week') {
      const prev = new Date(currentDate);
      prev.setDate(prev.getDate() - 7);
      setCurrentDate(prev);
    } else {
      const prev = new Date(currentDate);
      prev.setDate(prev.getDate() - 1);
      setCurrentDate(prev);
    }
  };

  const handleNext = () => {
    if (viewMode === 'month') {
      setCurrentDate(new Date(year, month + 1, 1));
    } else if (viewMode === 'week') {
      const next = new Date(currentDate);
      next.setDate(next.getDate() + 7);
      setCurrentDate(next);
    } else {
      const next = new Date(currentDate);
      next.setDate(next.getDate() + 1);
      setCurrentDate(next);
    }
  };

  const handleToday = () => {
    setCurrentDate(new Date());
  };

  // Group events by date string (YYYY-MM-DD)
  const eventsByDate = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    calendarEvents.forEach(evt => {
      if (!map[evt.date]) map[evt.date] = [];
      map[evt.date].push(evt);
    });
    return map;
  }, [calendarEvents]);

  const handleCreateEvent = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEvent.title.trim()) return;

    addCalendarEvent({
      brandId: newEvent.brandId || activeBrandId,
      title: newEvent.title.trim(),
      platform: newEvent.platform,
      date: newEvent.date,
      time: newEvent.time,
      status: newEvent.status,
      summary: newEvent.summary.trim(),
    });

    setIsAddModalOpen(false);
    setNewEvent({
      title: '',
      platform: 'linkedin',
      date: toLocalDateKey(addDays(new Date(), 1)),
      time: '10:00',
      status: 'scheduled',
      summary: '',
      brandId: activeBrandId,
    });
  };

  return (
    <div className="space-y-6">
      {/* Calendar Header with Scope Banner */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
        {/* Phase 1 Notice Box as explicitly requested in prompt */}
        <div className="p-3.5 bg-zinc-950 border border-zinc-800/80 rounded-lg flex items-start gap-3">
          <Radio className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0 animate-pulse" />
          <div className="text-xs text-zinc-300 leading-relaxed space-y-0.5">
            <span className="font-semibold text-zinc-100">Phase 1 Content Scheduling State Active: </span>
            <span>
              This calendar manages planning, date assignment, draft states, and team workflow previews. Direct social API publishing (Meta Graph API, YouTube API, X API) is scheduled for Phase 2.
            </span>
          </div>
        </div>

        {/* Navigation & Controls */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-bold text-zinc-100 min-w-44">
              {monthName}
            </h2>

            <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 rounded-lg p-0.5">
              <button
                onClick={handlePrev}
                className="p-1.5 text-zinc-400 hover:text-zinc-100 rounded-md transition-colors"
                aria-label="Previous period"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={handleToday}
                className="px-2.5 py-1 text-xs font-medium text-zinc-300 hover:text-white transition-colors"
              >
                Today
              </button>
              <button
                onClick={handleNext}
                className="p-1.5 text-zinc-400 hover:text-zinc-100 rounded-md transition-colors"
                aria-label="Next period"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* View Mode Toggle */}
            <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-lg p-1 text-xs">
              {(['month', 'week', 'day'] as CalendarViewMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`px-3 py-1 font-medium capitalize rounded-md transition-colors ${
                    viewMode === mode
                      ? 'bg-zinc-800 text-zinc-100 shadow-xs'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>

            <button
              onClick={() => setIsAddModalOpen(true)}
              disabled={!canWrite}
              title={canWrite ? undefined : 'Viewer role — this workspace is read-only'}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Schedule Event</span>
            </button>
          </div>
        </div>
      </div>

      {/* Calendar Views */}
      {viewMode === 'month' && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          {/* Day Names Bar */}
          <div className="grid grid-cols-7 border-b border-zinc-800 bg-zinc-950/60 text-center py-2.5 text-xs font-medium text-zinc-400">
            <span>Sun</span>
            <span>Mon</span>
            <span>Tue</span>
            <span>Wed</span>
            <span>Thu</span>
            <span>Fri</span>
            <span>Sat</span>
          </div>

          {/* Month Grid */}
          <div className="grid grid-cols-7 auto-rows-fr divide-x divide-y divide-zinc-800/80 bg-zinc-950">
            {/* Empty slots for offset */}
            {Array.from({ length: firstDayIndex }).map((_, idx) => (
              <div key={`empty-${idx}`} className="min-h-28 bg-zinc-950/40 p-2 text-zinc-700 text-xs" />
            ))}

            {/* Actual Month Days */}
            {Array.from({ length: daysInMonth }).map((_, idx) => {
              const dayNum = idx + 1;
              const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
              const dayEvents = eventsByDate[dateStr] || [];
              const isToday =
                dayNum === new Date().getDate() &&
                month === new Date().getMonth() &&
                year === new Date().getFullYear();

              return (
                <div
                  key={dateStr}
                  className={`min-h-28 p-2 transition-colors hover:bg-zinc-900/60 flex flex-col justify-between ${
                    isToday ? 'bg-zinc-900/90 ring-1 ring-emerald-500/50' : 'bg-zinc-950'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span
                      className={`text-xs font-mono font-medium ${
                        isToday
                          ? 'w-5 h-5 rounded-full bg-emerald-500 text-zinc-950 flex items-center justify-center font-bold'
                          : 'text-zinc-400'
                      }`}
                    >
                      {dayNum}
                    </span>
                    {dayEvents.length > 0 && (
                      <span className="text-[10px] text-zinc-500 font-mono">
                        {dayEvents.length} post{dayEvents.length > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>

                  {/* Day Events Stack */}
                  <div className="space-y-1 flex-1 overflow-y-auto max-h-24">
                    {dayEvents.map(evt => {
                      const isScheduled = evt.status === 'scheduled';
                      return (
                        <button
                          key={evt.id}
                          onClick={() => setSelectedEvent(evt)}
                          className={`w-full text-left p-1 rounded-md text-[11px] truncate flex items-center gap-1.5 transition-colors border ${
                            isScheduled
                              ? 'bg-emerald-950/70 border-emerald-900/70 text-emerald-200 hover:bg-emerald-900/80'
                              : 'bg-zinc-800/80 border-zinc-700/80 text-zinc-300 hover:bg-zinc-700'
                          }`}
                        >
                          <PlatformIcon platform={evt.platform} className="w-3 h-3 shrink-0" />
                          <span className="truncate">{evt.title}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Week View */}
      {viewMode === 'week' && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-zinc-100">7-Day Content Stream</h3>
          <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
            {Array.from({ length: 7 }).map((_, i) => {
              const d = new Date(currentDate);
              const dayOfWeek = d.getDay();
              d.setDate(d.getDate() - dayOfWeek + i);
              // Local date key — NOT toISOString(), which returns the UTC
              // date and mis-files cells by one day for UTC+ timezones
              // such as Asia/Karachi (audit item B-2).
              const dateStr = toLocalDateKey(d);
              const dayEvents = eventsByDate[dateStr] || [];

              return (
                <div
                  key={dateStr}
                  className="bg-zinc-950 border border-zinc-800/80 rounded-lg p-3 space-y-2 min-h-60"
                >
                  <div className="border-b border-zinc-800 pb-2">
                    <span className="text-[11px] font-medium text-zinc-500 uppercase block">
                      {d.toLocaleDateString('default', { weekday: 'short' })}
                    </span>
                    <span className="text-sm font-bold text-zinc-200 font-mono">
                      {d.getDate()}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    {dayEvents.length === 0 ? (
                      <span className="text-[10px] text-zinc-600 block py-4 text-center">Empty</span>
                    ) : (
                      dayEvents.map(evt => (
                        <div
                          key={evt.id}
                          onClick={() => setSelectedEvent(evt)}
                          className="p-2 bg-zinc-900 border border-zinc-800 rounded-md text-xs cursor-pointer hover:border-zinc-700 space-y-1"
                        >
                          <div className="flex items-center gap-1 text-[10px] text-zinc-400 font-mono">
                            <Clock className="w-3 h-3 text-zinc-500" />
                            <span>{evt.time}</span>
                          </div>
                          <p className="font-medium text-zinc-200 line-clamp-2 leading-snug">
                            {evt.title}
                          </p>
                          <div className="flex items-center gap-1 text-[10px] text-emerald-400">
                            <PlatformIcon platform={evt.platform} className="w-3 h-3" />
                            <span className="capitalize">{evt.status}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Day View */}
      {viewMode === 'day' && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
            <div>
              <h3 className="text-base font-semibold text-zinc-100">
                {currentDate.toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </h3>
              <p className="text-xs text-zinc-500">Day timetable and posting queue</p>
            </div>
            <span className="text-xs text-zinc-400 font-mono">
              {(eventsByDate[toLocalDateKey(currentDate)] || []).length} scheduled
            </span>
          </div>

          <div className="space-y-2">
            {(eventsByDate[toLocalDateKey(currentDate)] || []).length === 0 ? (
              <p className="text-xs text-zinc-500 py-8 text-center">No campaigns scheduled for this date.</p>
            ) : (
              (eventsByDate[toLocalDateKey(currentDate)] || []).map(evt => (
                <div
                  key={evt.id}
                  onClick={() => setSelectedEvent(evt)}
                  className="p-4 bg-zinc-950 border border-zinc-800 rounded-lg flex items-center justify-between cursor-pointer hover:border-zinc-700 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 bg-zinc-900 rounded-lg text-emerald-400">
                      <PlatformIcon platform={evt.platform} className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-zinc-100">{evt.title}</h4>
                      <p className="text-xs text-zinc-400 line-clamp-1">{evt.summary || 'Scheduled content campaign'}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-xs font-mono text-zinc-200 block">{evt.time} PKT</span>
                    <span className="text-[10px] text-emerald-400 uppercase font-semibold">{evt.status}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Inspect Event Modal */}
      {selectedEvent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-5 space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2">
                <PlatformIcon platform={selectedEvent.platform} className="w-4 h-4 text-emerald-400" />
                <span className="text-sm font-semibold text-zinc-100">{selectedEvent.title}</span>
              </div>
              <button
                onClick={() => setSelectedEvent(null)}
                className="text-zinc-400 hover:text-zinc-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2 p-3 bg-zinc-950 rounded-lg border border-zinc-800/80">
                <div>
                  <span className="text-zinc-500 block">Date</span>
                  <span className="text-zinc-200 font-mono font-medium">{selectedEvent.date}</span>
                </div>
                <div>
                  <span className="text-zinc-500 block">Time</span>
                  <span className="text-zinc-200 font-mono font-medium">{selectedEvent.time}</span>
                </div>
                <div>
                  <span className="text-zinc-500 block">Platform</span>
                  <span className="text-zinc-200 font-medium capitalize">{selectedEvent.platform.replace('_', ' ')}</span>
                </div>
                <div>
                  <span className="text-zinc-500 block">Workflow State</span>
                  <span className="text-emerald-400 font-medium uppercase">{selectedEvent.status}</span>
                </div>
              </div>

              {selectedEvent.summary && (
                <div>
                  <span className="text-zinc-400 font-medium block mb-1">Content Summary</span>
                  <p className="text-zinc-300 bg-zinc-950 p-2.5 rounded-lg border border-zinc-800/80 leading-relaxed">
                    {selectedEvent.summary}
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
              <button
                type="button"
                onClick={() => {
                  deleteCalendarEvent(selectedEvent.id);
                  setSelectedEvent(null);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-950/40 rounded-lg transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Remove from Calendar</span>
              </button>

              <button
                type="button"
                onClick={() => setSelectedEvent(null)}
                className="px-3.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Schedule Event Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-5 space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2">
                <CalendarDays className="w-4 h-4 text-emerald-400" />
                <span className="text-sm font-semibold text-zinc-100">Schedule Content Campaign</span>
              </div>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="text-zinc-400 hover:text-zinc-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateEvent} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Campaign Title <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={newEvent.title}
                  onChange={e => setNewEvent({ ...newEvent, title: e.target.value })}
                  placeholder="e.g. Weekly Cloud Optimization Teardown"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1">Platform</label>
                  <select
                    value={newEvent.platform}
                    onChange={e => setNewEvent({ ...newEvent, platform: e.target.value as PlatformType })}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                  >
                    {Object.values(PLATFORMS_CONFIG).map(p => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1">Workflow State</label>
                  <select
                    value={newEvent.status}
                    onChange={e => setNewEvent({ ...newEvent, status: e.target.value as 'draft' | 'scheduled' })}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                  >
                    <option value="scheduled">Scheduled</option>
                    <option value="draft">Draft Hold</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1">Date</label>
                  <input
                    type="date"
                    required
                    value={newEvent.date}
                    onChange={e => setNewEvent({ ...newEvent, date: e.target.value })}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1">Time</label>
                  <input
                    type="time"
                    required
                    value={newEvent.time}
                    onChange={e => setNewEvent({ ...newEvent, time: e.target.value })}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Notes / Summary</label>
                <textarea
                  rows={2}
                  value={newEvent.summary}
                  onChange={e => setNewEvent({ ...newEvent, summary: e.target.value })}
                  placeholder="Key campaign focus or link to asset..."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500 resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-xs"
                >
                  Add to Calendar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
