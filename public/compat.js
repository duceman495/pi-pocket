/* 老版 Android WebView 兼容补丁（只用 ES5 语法，必须最先加载） */
(function () {
	// Chrome 86+ 才有；旧 WebView 会直接报错，这里补上
	if (!Element.prototype.replaceChildren) {
		Element.prototype.replaceChildren = function () {
			while (this.firstChild) this.removeChild(this.firstChild);
			if (arguments.length) this.append.apply(this, arguments);
		};
	}
	if (!Document.prototype.replaceChildren && Element.prototype.replaceChildren) {
		Document.prototype.replaceChildren = Element.prototype.replaceChildren;
	}
	if (!DocumentFragment.prototype.replaceChildren && Element.prototype.replaceChildren) {
		DocumentFragment.prototype.replaceChildren = Element.prototype.replaceChildren;
	}
	// Chrome 54+，极老机器兜底
	if (!Element.prototype.append) {
		Element.prototype.append = function () {
			for (var i = 0; i < arguments.length; i++) {
				var n = arguments[i];
				this.appendChild(typeof n === "string" ? document.createTextNode(n) : n);
			}
		};
	}
	// Chrome 51+，兜底
	if (!Element.prototype.remove) {
		Element.prototype.remove = function () {
			if (this.parentNode) this.parentNode.removeChild(this);
		};
	}
})();
