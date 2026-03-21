if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
        .then(reg => console.log('🐱 Service Worker registered'))
        .catch(err => console.warn('Service Worker registration failed:', err));
}
