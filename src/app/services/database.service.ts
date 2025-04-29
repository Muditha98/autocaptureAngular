import { Injectable } from '@angular/core';
import { openDB, IDBPDatabase } from 'idb';

interface IdCardEntry {
  id: string;
  image: string;
  country: string;
  documentType: string;
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class DatabaseService {
  private db: IDBPDatabase | null = null;
  private readonly DB_NAME = 'idcard_db';
  private readonly STORE_NAME = 'idcard_store';

  constructor() {
    this.initDatabase();
  }

  private async initDatabase() {
    try {
      this.db = await openDB(this.DB_NAME, 1, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('idcard_store')) {
            db.createObjectStore('idcard_store', { keyPath: 'id' });
          }
        },
      });
      console.log('Database initialized successfully');
    } catch (error) {
      console.error('Error initializing database:', error);
    }
  }

  async storeIdCardData(image: string, country: string, documentType: string): Promise<string> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const entry: IdCardEntry = {
      id: crypto.randomUUID(), // Generate unique ID
      image,
      country,
      documentType,
      timestamp: Date.now()
    };

    try {
      await this.db.put(this.STORE_NAME, entry);
      return entry.id;
    } catch (error) {
      console.error('Error storing data:', error);
      throw error;
    }
  }

  async getIdCardData(id: string): Promise<IdCardEntry | undefined> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      return await this.db.get(this.STORE_NAME, id);
    } catch (error) {
      console.error('Error retrieving data:', error);
      throw error;
    }
  }
}