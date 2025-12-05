import * as fs from 'fs/promises';
import * as path from 'path';
import { FeedbackItem, AnalyzedFeedback } from '../types/feedback.js';
import { AnalysisReport } from '../types/analysis.js';

export class FeedbackStore {
  private dataDir: string;

  constructor(dataDir: string = './data') {
    this.dataDir = dataDir;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(path.join(this.dataDir, 'feedback'), { recursive: true });
    await fs.mkdir(path.join(this.dataDir, 'analyzed'), { recursive: true });
    await fs.mkdir(path.join(this.dataDir, 'reports'), { recursive: true });
  }

  async saveFeedback(items: FeedbackItem[]): Promise<void> {
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = path.join(this.dataDir, 'feedback', `${timestamp}.json`);

    let existing: FeedbackItem[] = [];
    try {
      const content = await fs.readFile(filename, 'utf-8');
      existing = JSON.parse(content);
    } catch {
      // File doesn't exist yet
    }

    const combined = [...existing, ...items];
    await fs.writeFile(filename, JSON.stringify(combined, null, 2));
  }

  async saveAnalyzedFeedback(items: AnalyzedFeedback[]): Promise<void> {
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = path.join(this.dataDir, 'analyzed', `${timestamp}.json`);

    let existing: AnalyzedFeedback[] = [];
    try {
      const content = await fs.readFile(filename, 'utf-8');
      existing = JSON.parse(content, (key, value) => {
        if (key === 'timestamp' && typeof value === 'string') {
          return new Date(value);
        }
        return value;
      });
    } catch {
      // File doesn't exist yet
    }

    const combined = [...existing, ...items];
    await fs.writeFile(filename, JSON.stringify(combined, null, 2));
  }

  async saveReport(report: AnalysisReport): Promise<void> {
    const timestamp = report.timestamp.toISOString().replace(/:/g, '-');
    const filename = path.join(this.dataDir, 'reports', `${timestamp}.json`);
    await fs.writeFile(filename, JSON.stringify(report, null, 2));
  }

  async getRecentFeedback(days: number = 7): Promise<AnalyzedFeedback[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const files = await fs.readdir(path.join(this.dataDir, 'analyzed'));
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    const allFeedback: AnalyzedFeedback[] = [];
    for (const file of jsonFiles) {
      const content = await fs.readFile(
        path.join(this.dataDir, 'analyzed', file),
        'utf-8'
      );
      const items: AnalyzedFeedback[] = JSON.parse(content, (key, value) => {
        if (key === 'timestamp' && typeof value === 'string') {
          return new Date(value);
        }
        return value;
      });
      allFeedback.push(...items.filter(item => item.timestamp >= cutoff));
    }

    return allFeedback;
  }

  async getLatestReport(): Promise<AnalysisReport | null> {
    try {
      const files = await fs.readdir(path.join(this.dataDir, 'reports'));
      const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse();

      if (jsonFiles.length === 0) {
        return null;
      }

      const content = await fs.readFile(
        path.join(this.dataDir, 'reports', jsonFiles[0]),
        'utf-8'
      );
      return JSON.parse(content, (key, value) => {
        if ((key === 'timestamp' || key === 'start' || key === 'end') && typeof value === 'string') {
          return new Date(value);
        }
        return value;
      });
    } catch {
      return null;
    }
  }
}
