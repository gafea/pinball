class EventManager {
  constructor() {
    this.listerners = new Map();
    this.nextId = 1;
  }

  subscribe(eventType, listener, priority = 0) {
    const id = this.nextId++;
    this.listerners.set(id, { eventType, listener, priority });
    return id;
  }

  unsubscribe(id) {
    this.listerners.delete(id);
  }

  notify(notifyEventType, data) {
    // Sort listeners by priority
    const sortedListeners = Array.from(this.listerners.values())
      .filter(({ eventType }) => eventType === notifyEventType)
      .sort((a, b) => b.priority - a.priority);
    for (let { listener } of sortedListeners) {
      listener(data);
    }
  }
}

window.eventManager = new EventManager();
