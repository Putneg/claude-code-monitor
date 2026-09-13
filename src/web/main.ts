import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/jetbrains-mono/800.css';
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('app');
if (target === null) throw new Error('#app element is missing from index.html');

// ECharts draws text on a canvas, so the font should be ready before the first chart renders.
await document.fonts.load('400 12px "JetBrains Mono"').catch((error: unknown) => {
  console.info('JetBrains Mono did not load, using the fallback monospace font', error);
});

mount(App, { target });
