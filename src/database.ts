/**
 * @module CoreModule
 */ /** */
import { Inject, Injectable } from '@angular/core';
import { AngularFire, FirebaseListObservable, FirebaseObjectObservable } from 'angularfire2';
import { FirebaseListFactoryOpts, FirebaseObjectFactoryOpts } from 'angularfire2/interfaces';

import { AfoListObservable } from './afo-list-observable';
import { AfoObjectObservable } from './afo-object-observable';
import { AngularFireOfflineCache, CacheItem, WriteCache } from './interfaces';
import { LocalForageToken } from './localforage';
import { LocalUpdateService } from './local-update-service';
import { WriteComplete } from './offline-write';

/**
 * @whatItDoes Wraps some angularfire2 read methods for returning data from Firebase with the added
 * function of storing the data locally for offline use.
 *
 * --------------------------------------------------------
 * --------------------------------------------------------
 *
 * **Features:**
 * - While online, Firebase data is stored locally (as data changes the local store is updated)
 * - While offline, local data is served if available
 * - On reconnect, Observables update app with new Firebase data
 * - Even while online, local data is used first when available which results in a faster load
 *
 */
@Injectable()
export class AngularFireOfflineDatabase {
  /**
   * - In-memory cache containing `ReplayItem`s that return the latest value
   * for any given Firebase reference.
   * - That value can come from a Firebase subscription or from the device if there is no
   * internet connection.
   */
  objectCache: AngularFireOfflineCache = {};
  listCache: AngularFireOfflineCache = {};
  /**
   * Creates the {@link AngularFireOfflineDatabase}
   *
   * @param af Angular Fire service used to connect to Firebase
   * @param localforage Angular 2 wrapper of [localforage](https://goo.gl/4RJ7Iy) that allows
   * storing data offline using asynchronous storage (IndexedDB or WebSQL) with a simple,
   * localStorage-like API
   */
  cacheIndex = 0;
  checkEmulateQue = {};
  processing = {
    current: true,
    listCache: {},
    objectCache: {}
  };
  constructor(private af: AngularFire,
    @Inject(LocalForageToken) private localForage: any,
    private localUpdateService: LocalUpdateService) {
    this.processWrites();
  }
  processWrites() {
    this.localForage.getItem('write').then((writeCache: WriteCache) => {
      if (!writeCache) { this.processingComplete(); return; }
      const cacheId = Object.keys(writeCache.cache)[this.cacheIndex];
      this.cacheIndex++;
      if (cacheId === undefined) {
        this.updateEmulateList();
        this.processingComplete();
        return;
      }
      const cacheItem: CacheItem = writeCache.cache[cacheId];
      this[cacheItem.type](cacheItem.ref); // init item if needed
      const sub = this[`${cacheItem.type}Cache`][cacheItem.ref].sub;
      sub.emulate(cacheItem.method, ...cacheItem.args);
      if (cacheItem.type === 'object' && cacheItem.method === 'set') { this.checkEmulateList(cacheItem); }
      this.af.database[cacheItem.type](cacheItem.ref)[cacheItem.method](...cacheItem.args)
        .then(() => WriteComplete(cacheId, this.localUpdateService));
      this.processWrites();
    });
  }
  /**
   * Returns an Observable array of Firebase snapshot data
   * - This method can be used in place of angularfire2's list method and it will work offline
   * - Sets up a list via {@link setupList} if {@link cache} is empty for this reference.
   * - Each list item is stored as a separate object for offline use. This allows offline access to
   * the entire list or a specific object in the list if the list is stored offline.
   * - Does not include angularfire2 meta-fields [such as](https://goo.gl/VhmxQW)
   * `$key` or `$exists`
   *
   * @param key the Firebase reference for this list
   * @param options optional angularfire2 options param. Allows all
   * [valid queries](https://goo.gl/iHiAuB)
   */
  list(key: string, options?: FirebaseListFactoryOpts): AfoListObservable<any[]> {
    if (!(key in this.listCache)) { this.setupList(key, options); }
    return this.listCache[key].sub;
  }
  /**
   * Returns an Observable object of Firebase snapshot data
   * - This method can be used in place of angularfire2's object method and it will work offline
   * - Sets up a list via {@link setupList} if {@link cache} is empty for this reference
   * - Does not include angularfire2 meta-fields [such as](https://goo.gl/XiwE0h)
   * `$key` or `$value`
   *
   * @param key the Firebase reference for this list
   * @param options optional angularfire2 options param. Allows all
   * [valid queries](https://goo.gl/iHiAuB) available [for objects](https://goo.gl/IV8DYA)
   */
  object(key: string, options?: FirebaseObjectFactoryOpts): AfoObjectObservable<any> {
    if (!(key in this.objectCache)) { this.setupObject(key, options); }
    return this.objectCache[key].sub;
  }
  /**
   * Retrives a list if locally stored on the device
   * - Lists are stored as individual objects, to allow for better offline reuse.
   * - Each locally stored list uses a map to stitch together the list from individual objects
   */
  private getList(key: string) {
    this.localForage.getItem(`read/list${key}`).then(primaryValue => {
      if (!this.listCache[key].loaded && primaryValue !== null) {
        const promises = primaryValue.map(partialKey => {
          return new Promise(resolve => {
            this.localForage.getItem(`read/object${key}/${partialKey}`).then(itemValue => {
              resolve(unwrap(partialKey, itemValue, () => itemValue !== null));
            });
          });
        });
        Promise.all(promises).then(cacheValue => {
          if (this.processing.current) {
            this.processing.listCache[key] = cacheValue;
          } else {
            this.listCache[key].sub.next(cacheValue);
          }
        });
      }
    });
  }
  private processingComplete() {
    this.processing.current = false;
    Object.keys(this.processing.listCache).forEach(cacheKey => {
      this.listCache[cacheKey].sub.next( this.processing.listCache[cacheKey] );
    });
    Object.keys(this.processing.objectCache).forEach(cacheKey => {
      this.objectCache[cacheKey].sub.next( this.processing.objectCache[cacheKey] );
    });
  }
  /**
   * - Sets up a {@link AngularFireOfflineCache} item that provides Firebase data
   * - Subscribes to the object's Firebase reference
   * - Gets the most recent locally stored non-null value and sends to all app subscribers
   * - When Firebase sends a value this {@link AngularFireOfflineCache} item is set to loaded,
   * the new value is sent to all app subscribers, and the value is stored locally
   *
   * @param key passed directly from {@link object}'s key param
   * @param options passed directly from {@link object}'s options param
   */
  private setupObject(key: string, options: FirebaseObjectFactoryOpts = {}) {
    // Get Firebase ref
    options.preserveSnapshot = true;
    const ref: FirebaseObjectObservable<any> = this.af.database.object(key, options);
    // Create cache
    this.objectCache[key] = {
      loaded: false,
      offlineInit: false,
      sub: new AfoObjectObservable(ref, this.localUpdateService)
    };
    // Firebase
    ref.subscribe(snap => {
      this.objectCache[key].loaded = true;
      const cacheValue = unwrap(snap.key, snap.val(), snap.exists);
      if (this.processing.current) {
        this.processing.objectCache[key] = cacheValue;
      } else {
        this.objectCache[key].sub.next( cacheValue );
      }
      this.localForage.setItem(`read/object${key}`, snap.val());
    });
    // Local
    this.localForage.getItem(`read/object${key}`).then(value => {
      if (!this.objectCache[key].loaded) {
        const cacheValue = unwrap(key.split('/').pop(), value, () => value !== null);
        if (this.processing.current) {
          this.processing.objectCache[key] = cacheValue;
        } else {
          this.objectCache[key].sub.next( cacheValue );
        }
      }
    });
  }
  private checkEmulateList(cacheItem: CacheItem) { // add matches to que
    const refItems: string[] = cacheItem.ref.split('/');
    refItems.pop();
    const potentialList: string = refItems.join('/');
    if (potentialList !== undefined) {
      if (!(potentialList in this.checkEmulateQue)) {
        this.checkEmulateQue[potentialList] = [];
      }
      this.checkEmulateQue[potentialList].push(cacheItem);
    }
  }
  /**
   * Stores a list for offline use
   * - Stores each list item as a separate object using the relavant Firebase reference string
   * to allow offline use of the entire list or just a specific object
   * - Stores a map of all the objects, used to stitch together the list for local use
   */
  private setList(key: string, array: Array<any>) {
    const primaryValue = array.reduce((p, c, i) => {
      this.localForage.setItem(`read/object${key}/${c.key}`, c.val());
      p[i] = c.key;
      return p;
    }, []);
    this.localForage.setItem(`read/list${key}`, primaryValue);
  }
  /**
   * - Sets up a {@link AngularFireOfflineCache} item that provides Firebase data
   * - Subscribes to the list's Firebase reference
   * - Gets the most recent locally stored non-null value and sends to all app subscribers
   * via {@link getList}
   * - When Firebase sends a value this {@link AngularFireOfflineCache} item is set to loaded,
   * the new value is sent to all app subscribers, and the value is stored locally via
   * {@link setList}
   *
   * @param key passed directly from {@link list}'s key param
   * @param options passed directly from {@link list}'s options param
   */
  private setupList(key: string, options: FirebaseListFactoryOpts = {}) {
    // Get Firebase ref
    options.preserveSnapshot = true;
    const ref: FirebaseListObservable<any[]> = this.af.database.list(key, options);
    // Create cache
    this.listCache[key] = {
      loaded: false,
      offlineInit: false,
      sub: new AfoListObservable(ref, this.localUpdateService)
    };
    // Firebase
    ref.subscribe(value => {
      this.listCache[key].loaded = true;
      const cacheValue = value.map(snap => unwrap(snap.key, snap.val(), snap.exists));
      if (this.processing.current) {
        this.processing.listCache[key] = cacheValue;
      } else {
        this.listCache[key].sub.next( cacheValue );
      }
      this.setList(key, value);
    });
    // Local
    this.getList(key);
  }
  private updateEmulateList() { // process emulate que
    Object.keys(this.checkEmulateQue).forEach(listKey => {
      if (listKey in this.listCache) {
        const sub = this.listCache[listKey].sub;
        this.checkEmulateQue[listKey].forEach((cacheItem: CacheItem) => {
          sub.emulate('update', ...cacheItem.args, cacheItem.ref.split('/').pop());
        });
        delete this.checkEmulateQue[listKey];
      }
    });
  }
}

export function isNil(obj: any): boolean {
  return obj === undefined || obj === null;
}

export function unwrap(key: string, value: any, exists) {
  let unwrapped = !isNil(value) ? value : { $value: null };
  if ((/string|number|boolean/).test(typeof value)) {
    unwrapped = { $value: value };
  }
  unwrapped.$exists = exists;
  unwrapped.$key = key;
  return unwrapped;
}
