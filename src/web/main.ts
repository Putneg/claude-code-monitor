// Latin and Cyrillic subsets only: session titles are often Russian; other scripts fall back to system fonts.
import './fonts.css';
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('app');
if (target === null) throw new Error('#app element is missing from index.html');

// ECharts draws text on a canvas, so the font should be ready before the first chart renders.
await document.fonts.load('400 12px "IBM Plex Sans"').catch((error: unknown) => {
  console.info('IBM Plex Sans did not load, using the fallback sans-serif font', error);
});

mount(App, { target });
