(function() {
  'use strict';
  var WAVVY_BASE = 'https://wavvy.app';

  function createWidget() {
    var container = document.createElement('div');
    container.id = 'wavvy-widget';
    container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;font-family:sans-serif;';

    // Toggle button
    var btn = document.createElement('button');
    btn.innerHTML = '🌊';
    btn.style.cssText = 'width:56px;height:56px;border-radius:50%;background:#1db954;border:none;cursor:pointer;font-size:24px;box-shadow:0 4px 20px rgba(29,185,84,0.4);transition:transform .2s;';
    btn.onmouseenter = function() { btn.style.transform = 'scale(1.1)'; };
    btn.onmouseleave = function() { btn.style.transform = 'scale(1)'; };

    // Chat iframe
    var iframe = document.createElement('iframe');
    iframe.src = WAVVY_BASE + '/embed';
    iframe.style.cssText = 'display:none;position:absolute;bottom:68px;right:0;width:380px;height:560px;border:none;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,0.4);';
    iframe.allow = 'autoplay';

    var open = false;
    btn.onclick = function() {
      open = !open;
      iframe.style.display = open ? 'block' : 'none';
      btn.innerHTML = open ? '✕' : '🌊';
    };

    container.appendChild(iframe);
    container.appendChild(btn);
    document.body.appendChild(container);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { createWidget(); });
  } else {
    createWidget();
  }
})();
