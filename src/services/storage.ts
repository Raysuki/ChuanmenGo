import { RiskLevel, type Household, type VisitRecord, type CreditRecord, type Note } from '../types';
import { parseISO, differenceInDays } from 'date-fns';

const KEYS = {
  HOUSEHOLDS: 'cmb_households',
  VISITS: 'cmb_visits',
  CREDITS: 'cmb_credits',
  NOTES: 'cmb_notes',
  SETTINGS: 'cmb_settings'
};

// Helper to get/set from localStorage
const get = (key: string) => {
  const data = localStorage.getItem(key);
  return data ? JSON.parse(data) : null;
};

const set = (key: string, data: any) => {
  localStorage.setItem(key, JSON.stringify(data));
};

export const storage = {
  // Households
  getHouseholds: (): Household[] => {
    const data = get(KEYS.HOUSEHOLDS) || [];
    return data.map((h: any) => ({
      ...h,
      name: String(h.name || "未命名"),
      skills: Array.isArray(h.skills) ? h.skills : (typeof h.skills === 'string' ? h.skills.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean) : [])
    }));
  },
  saveHouseholds: (data: Household[]) => set(KEYS.HOUSEHOLDS, data),
  
  // Settings
  getSettings: () => get(KEYS.SETTINGS) || { village_name: '科右前旗-红峰村', user_name: '李姐', last_export_at: '1970-01-01T00:00:00.000Z' },
  saveSetting: (key: string, value: string) => {
    const settings = storage.getSettings();
    settings[key] = value;
    set(KEYS.SETTINGS, settings);
  },

  // Todo Logic (Ported from server.ts)
  getTodo: (): Household[] => {
    const households = storage.getHouseholds();
    const today = new Date();
    return households.filter(h => {
      if (h.riskLevel === RiskLevel.GREEN) return false;
      if (!h.lastVisitedAt) return true;
      
      const lastVisit = parseISO(h.lastVisitedAt);
      const daysSinceLastVisit = differenceInDays(today, lastVisit);
      
      if (h.riskLevel === RiskLevel.RED) return daysSinceLastVisit >= 14;
      if (h.riskLevel === RiskLevel.YELLOW) return daysSinceLastVisit >= 30;
      return false;
    });
  },

  // Visits
  getVisits: () => get(KEYS.VISITS) || [],
  addVisit: (visit: any) => {
    const visits = storage.getVisits();
    visits.push(visit);
    set(KEYS.VISITS, visits);
    
    // Update household lastVisitedAt
    const households = storage.getHouseholds();
    const idx = households.findIndex(h => h.id === visit.householdId);
    if (idx !== -1) {
      households[idx].lastVisitedAt = visit.visitedAt;
      storage.saveHouseholds(households);
    }
  },

  // Credits
  getCreditsHistory: () => get(KEYS.CREDITS) || [],
  addCredit: (record: CreditRecord) => {
    const history = storage.getCreditsHistory();
    history.push(record);
    set(KEYS.CREDITS, history);
  },
  getCreditsSummary: () => {
    const households = storage.getHouseholds();
    const history = storage.getCreditsHistory();
    return households.map(h => {
      const points = history
        .filter((c: any) => c.householdId === h.id)
        .reduce((acc: number, curr: any) => acc + (curr.type === 'EARN' ? curr.points : -curr.points), 0);
      return { name: h.name, totalPoints: points };
    }).sort((a, b) => b.totalPoints - a.totalPoints);
  },

  // Notes
  getNotes: (): Note[] => get(KEYS.NOTES) || [],
  addNote: (note: Note) => {
    const notes = storage.getNotes();
    notes.unshift(note);
    set(KEYS.NOTES, notes);
  },
  updateNote: (id: string, content: string) => {
    const notes = storage.getNotes();
    const idx = notes.findIndex(n => n.id === id);
    if (idx !== -1) {
      notes[idx].content = content;
      notes[idx].createdAt = new Date().toISOString();
      set(KEYS.NOTES, notes);
    }
  },
  deleteNote: (id: string) => {
    const notes = storage.getNotes();
    set(KEYS.NOTES, notes.filter(n => n.id !== id));
  }
};
