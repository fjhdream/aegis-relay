// Runs before the page is first painted: a plain script in <head>, which the browser waits for.
// (app.js is a module and runs only once it and everything it imports have arrived; by then a person
// who uses the dark theme would have seen the light one.) The saved choice, else the system's.
// app.js holds the other half: the toggle, which saves under the same key.
(function(){let t;try{t=localStorage.getItem('aegis-theme')}catch{}if(t!=='dark'&&t!=='light')t=window.matchMedia&&matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.dataset.theme=t})();
