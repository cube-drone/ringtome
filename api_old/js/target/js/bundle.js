(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
  var __esm = (fn2, res) => function __init() {
    return fn2 && (res = (0, fn2[__getOwnPropNames(fn2)[0]])(fn2 = 0)), res;
  };
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key2 of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key2) && key2 !== except)
          __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // node_modules/preact/dist/preact.module.js
  function w(n3, l3) {
    for (var u3 in l3) n3[u3] = l3[u3];
    return n3;
  }
  function g(n3) {
    n3 && n3.parentNode && n3.parentNode.removeChild(n3);
  }
  function _(l3, u3, t4) {
    var i3, r3, o3, e3 = {};
    for (o3 in u3) "key" == o3 ? i3 = u3[o3] : "ref" == o3 ? r3 = u3[o3] : e3[o3] = u3[o3];
    if (arguments.length > 2 && (e3.children = arguments.length > 3 ? n.call(arguments, 2) : t4), "function" == typeof l3 && null != l3.defaultProps) for (o3 in l3.defaultProps) void 0 === e3[o3] && (e3[o3] = l3.defaultProps[o3]);
    return m(l3, e3, i3, r3, null);
  }
  function m(n3, t4, i3, r3, o3) {
    var e3 = { type: n3, props: t4, key: i3, ref: r3, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: void 0, __v: null == o3 ? ++u : o3, __i: -1, __u: 0 };
    return null == o3 && null != l.vnode && l.vnode(e3), e3;
  }
  function b() {
    return { current: null };
  }
  function k(n3) {
    return n3.children;
  }
  function x(n3, l3) {
    this.props = n3, this.context = l3;
  }
  function S(n3, l3) {
    if (null == l3) return n3.__ ? S(n3.__, n3.__i + 1) : null;
    for (var u3; l3 < n3.__k.length; l3++) if (null != (u3 = n3.__k[l3]) && null != u3.__e) return u3.__e;
    return "function" == typeof n3.type ? S(n3) : null;
  }
  function C(n3) {
    var l3, u3;
    if (null != (n3 = n3.__) && null != n3.__c) {
      for (n3.__e = n3.__c.base = null, l3 = 0; l3 < n3.__k.length; l3++) if (null != (u3 = n3.__k[l3]) && null != u3.__e) {
        n3.__e = n3.__c.base = u3.__e;
        break;
      }
      return C(n3);
    }
  }
  function M(n3) {
    (!n3.__d && (n3.__d = true) && i.push(n3) && !$.__r++ || r !== l.debounceRendering) && ((r = l.debounceRendering) || o)($);
  }
  function $() {
    for (var n3, u3, t4, r3, o3, f3, c3, s3 = 1; i.length; ) i.length > s3 && i.sort(e), n3 = i.shift(), s3 = i.length, n3.__d && (t4 = void 0, o3 = (r3 = (u3 = n3).__v).__e, f3 = [], c3 = [], u3.__P && ((t4 = w({}, r3)).__v = r3.__v + 1, l.vnode && l.vnode(t4), j(u3.__P, t4, r3, u3.__n, u3.__P.namespaceURI, 32 & r3.__u ? [o3] : null, f3, null == o3 ? S(r3) : o3, !!(32 & r3.__u), c3), t4.__v = r3.__v, t4.__.__k[t4.__i] = t4, z(f3, t4, c3), t4.__e != o3 && C(t4)));
    $.__r = 0;
  }
  function I(n3, l3, u3, t4, i3, r3, o3, e3, f3, c3, s3) {
    var a3, h3, y3, d3, w4, g4, _3 = t4 && t4.__k || v, m3 = l3.length;
    for (f3 = P(u3, l3, _3, f3, m3), a3 = 0; a3 < m3; a3++) null != (y3 = u3.__k[a3]) && (h3 = -1 === y3.__i ? p : _3[y3.__i] || p, y3.__i = a3, g4 = j(n3, y3, h3, i3, r3, o3, e3, f3, c3, s3), d3 = y3.__e, y3.ref && h3.ref != y3.ref && (h3.ref && V(h3.ref, null, y3), s3.push(y3.ref, y3.__c || d3, y3)), null == w4 && null != d3 && (w4 = d3), 4 & y3.__u || h3.__k === y3.__k ? f3 = A(y3, f3, n3) : "function" == typeof y3.type && void 0 !== g4 ? f3 = g4 : d3 && (f3 = d3.nextSibling), y3.__u &= -7);
    return u3.__e = w4, f3;
  }
  function P(n3, l3, u3, t4, i3) {
    var r3, o3, e3, f3, c3, s3 = u3.length, a3 = s3, h3 = 0;
    for (n3.__k = new Array(i3), r3 = 0; r3 < i3; r3++) null != (o3 = l3[r3]) && "boolean" != typeof o3 && "function" != typeof o3 ? (f3 = r3 + h3, (o3 = n3.__k[r3] = "string" == typeof o3 || "number" == typeof o3 || "bigint" == typeof o3 || o3.constructor == String ? m(null, o3, null, null, null) : d(o3) ? m(k, { children: o3 }, null, null, null) : void 0 === o3.constructor && o3.__b > 0 ? m(o3.type, o3.props, o3.key, o3.ref ? o3.ref : null, o3.__v) : o3).__ = n3, o3.__b = n3.__b + 1, e3 = null, -1 !== (c3 = o3.__i = L(o3, u3, f3, a3)) && (a3--, (e3 = u3[c3]) && (e3.__u |= 2)), null == e3 || null === e3.__v ? (-1 == c3 && h3--, "function" != typeof o3.type && (o3.__u |= 4)) : c3 != f3 && (c3 == f3 - 1 ? h3-- : c3 == f3 + 1 ? h3++ : (c3 > f3 ? h3-- : h3++, o3.__u |= 4))) : n3.__k[r3] = null;
    if (a3) for (r3 = 0; r3 < s3; r3++) null != (e3 = u3[r3]) && 0 == (2 & e3.__u) && (e3.__e == t4 && (t4 = S(e3)), q(e3, e3));
    return t4;
  }
  function A(n3, l3, u3) {
    var t4, i3;
    if ("function" == typeof n3.type) {
      for (t4 = n3.__k, i3 = 0; t4 && i3 < t4.length; i3++) t4[i3] && (t4[i3].__ = n3, l3 = A(t4[i3], l3, u3));
      return l3;
    }
    n3.__e != l3 && (l3 && n3.type && !u3.contains(l3) && (l3 = S(n3)), u3.insertBefore(n3.__e, l3 || null), l3 = n3.__e);
    do {
      l3 = l3 && l3.nextSibling;
    } while (null != l3 && 8 == l3.nodeType);
    return l3;
  }
  function H(n3, l3) {
    return l3 = l3 || [], null == n3 || "boolean" == typeof n3 || (d(n3) ? n3.some(function(n4) {
      H(n4, l3);
    }) : l3.push(n3)), l3;
  }
  function L(n3, l3, u3, t4) {
    var i3, r3, o3 = n3.key, e3 = n3.type, f3 = l3[u3];
    if (null === f3 || f3 && o3 == f3.key && e3 === f3.type && 0 == (2 & f3.__u)) return u3;
    if (t4 > (null != f3 && 0 == (2 & f3.__u) ? 1 : 0)) for (i3 = u3 - 1, r3 = u3 + 1; i3 >= 0 || r3 < l3.length; ) {
      if (i3 >= 0) {
        if ((f3 = l3[i3]) && 0 == (2 & f3.__u) && o3 == f3.key && e3 === f3.type) return i3;
        i3--;
      }
      if (r3 < l3.length) {
        if ((f3 = l3[r3]) && 0 == (2 & f3.__u) && o3 == f3.key && e3 === f3.type) return r3;
        r3++;
      }
    }
    return -1;
  }
  function T(n3, l3, u3) {
    "-" == l3[0] ? n3.setProperty(l3, null == u3 ? "" : u3) : n3[l3] = null == u3 ? "" : "number" != typeof u3 || y.test(l3) ? u3 : u3 + "px";
  }
  function F(n3, l3, u3, t4, i3) {
    var r3;
    n: if ("style" == l3) if ("string" == typeof u3) n3.style.cssText = u3;
    else {
      if ("string" == typeof t4 && (n3.style.cssText = t4 = ""), t4) for (l3 in t4) u3 && l3 in u3 || T(n3.style, l3, "");
      if (u3) for (l3 in u3) t4 && u3[l3] === t4[l3] || T(n3.style, l3, u3[l3]);
    }
    else if ("o" == l3[0] && "n" == l3[1]) r3 = l3 != (l3 = l3.replace(f, "$1")), l3 = l3.toLowerCase() in n3 || "onFocusOut" == l3 || "onFocusIn" == l3 ? l3.toLowerCase().slice(2) : l3.slice(2), n3.l || (n3.l = {}), n3.l[l3 + r3] = u3, u3 ? t4 ? u3.u = t4.u : (u3.u = c, n3.addEventListener(l3, r3 ? a : s, r3)) : n3.removeEventListener(l3, r3 ? a : s, r3);
    else {
      if ("http://www.w3.org/2000/svg" == i3) l3 = l3.replace(/xlink(H|:h)/, "h").replace(/sName$/, "s");
      else if ("width" != l3 && "height" != l3 && "href" != l3 && "list" != l3 && "form" != l3 && "tabIndex" != l3 && "download" != l3 && "rowSpan" != l3 && "colSpan" != l3 && "role" != l3 && "popover" != l3 && l3 in n3) try {
        n3[l3] = null == u3 ? "" : u3;
        break n;
      } catch (n4) {
      }
      "function" == typeof u3 || (null == u3 || false === u3 && "-" != l3[4] ? n3.removeAttribute(l3) : n3.setAttribute(l3, "popover" == l3 && 1 == u3 ? "" : u3));
    }
  }
  function O(n3) {
    return function(u3) {
      if (this.l) {
        var t4 = this.l[u3.type + n3];
        if (null == u3.t) u3.t = c++;
        else if (u3.t < t4.u) return;
        return t4(l.event ? l.event(u3) : u3);
      }
    };
  }
  function j(n3, u3, t4, i3, r3, o3, e3, f3, c3, s3) {
    var a3, h3, p3, v3, y3, _3, m3, b2, S2, C4, M3, $3, P4, A4, H3, L3, T4, F4, O3 = u3.type;
    if (void 0 !== u3.constructor) return null;
    128 & t4.__u && (c3 = !!(32 & t4.__u), o3 = [f3 = u3.__e = t4.__e]), (a3 = l.__b) && a3(u3);
    n: if ("function" == typeof O3) try {
      if (b2 = u3.props, S2 = "prototype" in O3 && O3.prototype.render, C4 = (a3 = O3.contextType) && i3[a3.__c], M3 = a3 ? C4 ? C4.props.value : a3.__ : i3, t4.__c ? m3 = (h3 = u3.__c = t4.__c).__ = h3.__E : (S2 ? u3.__c = h3 = new O3(b2, M3) : (u3.__c = h3 = new x(b2, M3), h3.constructor = O3, h3.render = B), C4 && C4.sub(h3), h3.props = b2, h3.state || (h3.state = {}), h3.context = M3, h3.__n = i3, p3 = h3.__d = true, h3.__h = [], h3._sb = []), S2 && null == h3.__s && (h3.__s = h3.state), S2 && null != O3.getDerivedStateFromProps && (h3.__s == h3.state && (h3.__s = w({}, h3.__s)), w(h3.__s, O3.getDerivedStateFromProps(b2, h3.__s))), v3 = h3.props, y3 = h3.state, h3.__v = u3, p3) S2 && null == O3.getDerivedStateFromProps && null != h3.componentWillMount && h3.componentWillMount(), S2 && null != h3.componentDidMount && h3.__h.push(h3.componentDidMount);
      else {
        if (S2 && null == O3.getDerivedStateFromProps && b2 !== v3 && null != h3.componentWillReceiveProps && h3.componentWillReceiveProps(b2, M3), !h3.__e && (null != h3.shouldComponentUpdate && false === h3.shouldComponentUpdate(b2, h3.__s, M3) || u3.__v == t4.__v)) {
          for (u3.__v != t4.__v && (h3.props = b2, h3.state = h3.__s, h3.__d = false), u3.__e = t4.__e, u3.__k = t4.__k, u3.__k.some(function(n4) {
            n4 && (n4.__ = u3);
          }), $3 = 0; $3 < h3._sb.length; $3++) h3.__h.push(h3._sb[$3]);
          h3._sb = [], h3.__h.length && e3.push(h3);
          break n;
        }
        null != h3.componentWillUpdate && h3.componentWillUpdate(b2, h3.__s, M3), S2 && null != h3.componentDidUpdate && h3.__h.push(function() {
          h3.componentDidUpdate(v3, y3, _3);
        });
      }
      if (h3.context = M3, h3.props = b2, h3.__P = n3, h3.__e = false, P4 = l.__r, A4 = 0, S2) {
        for (h3.state = h3.__s, h3.__d = false, P4 && P4(u3), a3 = h3.render(h3.props, h3.state, h3.context), H3 = 0; H3 < h3._sb.length; H3++) h3.__h.push(h3._sb[H3]);
        h3._sb = [];
      } else do {
        h3.__d = false, P4 && P4(u3), a3 = h3.render(h3.props, h3.state, h3.context), h3.state = h3.__s;
      } while (h3.__d && ++A4 < 25);
      h3.state = h3.__s, null != h3.getChildContext && (i3 = w(w({}, i3), h3.getChildContext())), S2 && !p3 && null != h3.getSnapshotBeforeUpdate && (_3 = h3.getSnapshotBeforeUpdate(v3, y3)), T4 = (L3 = null != a3 && a3.type === k && null == a3.key) ? a3.props.children : a3, L3 && (a3.props.children = null), f3 = I(n3, d(T4) ? T4 : [T4], u3, t4, i3, r3, o3, e3, f3, c3, s3), h3.base = u3.__e, u3.__u &= -161, h3.__h.length && e3.push(h3), m3 && (h3.__E = h3.__ = null);
    } catch (n4) {
      if (u3.__v = null, c3 || null != o3) if (n4.then) {
        for (u3.__u |= c3 ? 160 : 128; f3 && 8 == f3.nodeType && f3.nextSibling; ) f3 = f3.nextSibling;
        o3[o3.indexOf(f3)] = null, u3.__e = f3;
      } else for (F4 = o3.length; F4--; ) g(o3[F4]);
      else u3.__e = t4.__e, u3.__k = t4.__k;
      l.__e(n4, u3, t4);
    }
    else null == o3 && u3.__v == t4.__v ? (u3.__k = t4.__k, u3.__e = t4.__e) : f3 = u3.__e = N(t4.__e, u3, t4, i3, r3, o3, e3, c3, s3);
    return (a3 = l.diffed) && a3(u3), 128 & u3.__u ? void 0 : f3;
  }
  function z(n3, u3, t4) {
    for (var i3 = 0; i3 < t4.length; i3++) V(t4[i3], t4[++i3], t4[++i3]);
    l.__c && l.__c(u3, n3), n3.some(function(u4) {
      try {
        n3 = u4.__h, u4.__h = [], n3.some(function(n4) {
          n4.call(u4);
        });
      } catch (n4) {
        l.__e(n4, u4.__v);
      }
    });
  }
  function N(u3, t4, i3, r3, o3, e3, f3, c3, s3) {
    var a3, h3, v3, y3, w4, _3, m3, b2 = i3.props, k4 = t4.props, x4 = t4.type;
    if ("svg" == x4 ? o3 = "http://www.w3.org/2000/svg" : "math" == x4 ? o3 = "http://www.w3.org/1998/Math/MathML" : o3 || (o3 = "http://www.w3.org/1999/xhtml"), null != e3) {
      for (a3 = 0; a3 < e3.length; a3++) if ((w4 = e3[a3]) && "setAttribute" in w4 == !!x4 && (x4 ? w4.localName == x4 : 3 == w4.nodeType)) {
        u3 = w4, e3[a3] = null;
        break;
      }
    }
    if (null == u3) {
      if (null == x4) return document.createTextNode(k4);
      u3 = document.createElementNS(o3, x4, k4.is && k4), c3 && (l.__m && l.__m(t4, e3), c3 = false), e3 = null;
    }
    if (null === x4) b2 === k4 || c3 && u3.data === k4 || (u3.data = k4);
    else {
      if (e3 = e3 && n.call(u3.childNodes), b2 = i3.props || p, !c3 && null != e3) for (b2 = {}, a3 = 0; a3 < u3.attributes.length; a3++) b2[(w4 = u3.attributes[a3]).name] = w4.value;
      for (a3 in b2) if (w4 = b2[a3], "children" == a3) ;
      else if ("dangerouslySetInnerHTML" == a3) v3 = w4;
      else if (!(a3 in k4)) {
        if ("value" == a3 && "defaultValue" in k4 || "checked" == a3 && "defaultChecked" in k4) continue;
        F(u3, a3, null, w4, o3);
      }
      for (a3 in k4) w4 = k4[a3], "children" == a3 ? y3 = w4 : "dangerouslySetInnerHTML" == a3 ? h3 = w4 : "value" == a3 ? _3 = w4 : "checked" == a3 ? m3 = w4 : c3 && "function" != typeof w4 || b2[a3] === w4 || F(u3, a3, w4, b2[a3], o3);
      if (h3) c3 || v3 && (h3.__html === v3.__html || h3.__html === u3.innerHTML) || (u3.innerHTML = h3.__html), t4.__k = [];
      else if (v3 && (u3.innerHTML = ""), I("template" === t4.type ? u3.content : u3, d(y3) ? y3 : [y3], t4, i3, r3, "foreignObject" == x4 ? "http://www.w3.org/1999/xhtml" : o3, e3, f3, e3 ? e3[0] : i3.__k && S(i3, 0), c3, s3), null != e3) for (a3 = e3.length; a3--; ) g(e3[a3]);
      c3 || (a3 = "value", "progress" == x4 && null == _3 ? u3.removeAttribute("value") : void 0 !== _3 && (_3 !== u3[a3] || "progress" == x4 && !_3 || "option" == x4 && _3 !== b2[a3]) && F(u3, a3, _3, b2[a3], o3), a3 = "checked", void 0 !== m3 && m3 !== u3[a3] && F(u3, a3, m3, b2[a3], o3));
    }
    return u3;
  }
  function V(n3, u3, t4) {
    try {
      if ("function" == typeof n3) {
        var i3 = "function" == typeof n3.__u;
        i3 && n3.__u(), i3 && null == u3 || (n3.__u = n3(u3));
      } else n3.current = u3;
    } catch (n4) {
      l.__e(n4, t4);
    }
  }
  function q(n3, u3, t4) {
    var i3, r3;
    if (l.unmount && l.unmount(n3), (i3 = n3.ref) && (i3.current && i3.current !== n3.__e || V(i3, null, u3)), null != (i3 = n3.__c)) {
      if (i3.componentWillUnmount) try {
        i3.componentWillUnmount();
      } catch (n4) {
        l.__e(n4, u3);
      }
      i3.base = i3.__P = null;
    }
    if (i3 = n3.__k) for (r3 = 0; r3 < i3.length; r3++) i3[r3] && q(i3[r3], u3, t4 || "function" != typeof n3.type);
    t4 || g(n3.__e), n3.__c = n3.__ = n3.__e = void 0;
  }
  function B(n3, l3, u3) {
    return this.constructor(n3, u3);
  }
  function D(u3, t4, i3) {
    var r3, o3, e3, f3;
    t4 == document && (t4 = document.documentElement), l.__ && l.__(u3, t4), o3 = (r3 = "function" == typeof i3) ? null : i3 && i3.__k || t4.__k, e3 = [], f3 = [], j(t4, u3 = (!r3 && i3 || t4).__k = _(k, null, [u3]), o3 || p, p, t4.namespaceURI, !r3 && i3 ? [i3] : o3 ? null : t4.firstChild ? n.call(t4.childNodes) : null, e3, !r3 && i3 ? i3 : o3 ? o3.__e : t4.firstChild, r3, f3), z(e3, u3, f3);
  }
  function E(n3, l3) {
    D(n3, l3, E);
  }
  function G(l3, u3, t4) {
    var i3, r3, o3, e3, f3 = w({}, l3.props);
    for (o3 in l3.type && l3.type.defaultProps && (e3 = l3.type.defaultProps), u3) "key" == o3 ? i3 = u3[o3] : "ref" == o3 ? r3 = u3[o3] : f3[o3] = void 0 === u3[o3] && void 0 !== e3 ? e3[o3] : u3[o3];
    return arguments.length > 2 && (f3.children = arguments.length > 3 ? n.call(arguments, 2) : t4), m(l3.type, f3, i3 || l3.key, r3 || l3.ref, null);
  }
  function J(n3) {
    function l3(n4) {
      var u3, t4;
      return this.getChildContext || (u3 = /* @__PURE__ */ new Set(), (t4 = {})[l3.__c] = this, this.getChildContext = function() {
        return t4;
      }, this.componentWillUnmount = function() {
        u3 = null;
      }, this.shouldComponentUpdate = function(n5) {
        this.props.value !== n5.value && u3.forEach(function(n6) {
          n6.__e = true, M(n6);
        });
      }, this.sub = function(n5) {
        u3.add(n5);
        var l4 = n5.componentWillUnmount;
        n5.componentWillUnmount = function() {
          u3 && u3.delete(n5), l4 && l4.call(n5);
        };
      }), n4.children;
    }
    __name(l3, "l");
    return l3.__c = "__cC" + h++, l3.__ = n3, l3.Provider = l3.__l = (l3.Consumer = function(n4, l4) {
      return n4.children(l4);
    }).contextType = l3, l3;
  }
  var n, l, u, t, i, r, o, e, f, c, s, a, h, p, v, y, d;
  var init_preact_module = __esm({
    "node_modules/preact/dist/preact.module.js"() {
      p = {};
      v = [];
      y = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i;
      d = Array.isArray;
      __name(w, "w");
      __name(g, "g");
      __name(_, "_");
      __name(m, "m");
      __name(b, "b");
      __name(k, "k");
      __name(x, "x");
      __name(S, "S");
      __name(C, "C");
      __name(M, "M");
      __name($, "$");
      __name(I, "I");
      __name(P, "P");
      __name(A, "A");
      __name(H, "H");
      __name(L, "L");
      __name(T, "T");
      __name(F, "F");
      __name(O, "O");
      __name(j, "j");
      __name(z, "z");
      __name(N, "N");
      __name(V, "V");
      __name(q, "q");
      __name(B, "B");
      __name(D, "D");
      __name(E, "E");
      __name(G, "G");
      __name(J, "J");
      n = v.slice, l = { __e: /* @__PURE__ */ __name(function(n3, l3, u3, t4) {
        for (var i3, r3, o3; l3 = l3.__; ) if ((i3 = l3.__c) && !i3.__) try {
          if ((r3 = i3.constructor) && null != r3.getDerivedStateFromError && (i3.setState(r3.getDerivedStateFromError(n3)), o3 = i3.__d), null != i3.componentDidCatch && (i3.componentDidCatch(n3, t4 || {}), o3 = i3.__d), o3) return i3.__E = i3;
        } catch (l4) {
          n3 = l4;
        }
        throw n3;
      }, "__e") }, u = 0, t = /* @__PURE__ */ __name(function(n3) {
        return null != n3 && null == n3.constructor;
      }, "t"), x.prototype.setState = function(n3, l3) {
        var u3;
        u3 = null != this.__s && this.__s !== this.state ? this.__s : this.__s = w({}, this.state), "function" == typeof n3 && (n3 = n3(w({}, u3), this.props)), n3 && w(u3, n3), null != n3 && this.__v && (l3 && this._sb.push(l3), M(this));
      }, x.prototype.forceUpdate = function(n3) {
        this.__v && (this.__e = true, n3 && this.__h.push(n3), M(this));
      }, x.prototype.render = k, i = [], o = "function" == typeof Promise ? Promise.prototype.then.bind(Promise.resolve()) : setTimeout, e = /* @__PURE__ */ __name(function(n3, l3) {
        return n3.__v.__b - l3.__v.__b;
      }, "e"), $.__r = 0, f = /(PointerCapture)$|Capture$/i, c = 0, s = O(false), a = O(true), h = 0;
    }
  });

  // node_modules/preact/hooks/dist/hooks.module.js
  function p2(n3, t4) {
    c2.__h && c2.__h(r2, n3, o2 || t4), o2 = 0;
    var u3 = r2.__H || (r2.__H = { __: [], __h: [] });
    return n3 >= u3.__.length && u3.__.push({}), u3.__[n3];
  }
  function d2(n3) {
    return o2 = 1, h2(D2, n3);
  }
  function h2(n3, u3, i3) {
    var o3 = p2(t2++, 2);
    if (o3.t = n3, !o3.__c && (o3.__ = [i3 ? i3(u3) : D2(void 0, u3), function(n4) {
      var t4 = o3.__N ? o3.__N[0] : o3.__[0], r3 = o3.t(t4, n4);
      t4 !== r3 && (o3.__N = [r3, o3.__[1]], o3.__c.setState({}));
    }], o3.__c = r2, !r2.__f)) {
      var f3 = /* @__PURE__ */ __name(function(n4, t4, r3) {
        if (!o3.__c.__H) return true;
        var u4 = o3.__c.__H.__.filter(function(n5) {
          return !!n5.__c;
        });
        if (u4.every(function(n5) {
          return !n5.__N;
        })) return !c3 || c3.call(this, n4, t4, r3);
        var i4 = o3.__c.props !== n4;
        return u4.forEach(function(n5) {
          if (n5.__N) {
            var t5 = n5.__[0];
            n5.__ = n5.__N, n5.__N = void 0, t5 !== n5.__[0] && (i4 = true);
          }
        }), c3 && c3.call(this, n4, t4, r3) || i4;
      }, "f");
      r2.__f = true;
      var c3 = r2.shouldComponentUpdate, e3 = r2.componentWillUpdate;
      r2.componentWillUpdate = function(n4, t4, r3) {
        if (this.__e) {
          var u4 = c3;
          c3 = void 0, f3(n4, t4, r3), c3 = u4;
        }
        e3 && e3.call(this, n4, t4, r3);
      }, r2.shouldComponentUpdate = f3;
    }
    return o3.__N || o3.__;
  }
  function y2(n3, u3) {
    var i3 = p2(t2++, 3);
    !c2.__s && C2(i3.__H, u3) && (i3.__ = n3, i3.u = u3, r2.__H.__h.push(i3));
  }
  function _2(n3, u3) {
    var i3 = p2(t2++, 4);
    !c2.__s && C2(i3.__H, u3) && (i3.__ = n3, i3.u = u3, r2.__h.push(i3));
  }
  function A2(n3) {
    return o2 = 5, T2(function() {
      return { current: n3 };
    }, []);
  }
  function F2(n3, t4, r3) {
    o2 = 6, _2(function() {
      if ("function" == typeof n3) {
        var r4 = n3(t4());
        return function() {
          n3(null), r4 && "function" == typeof r4 && r4();
        };
      }
      if (n3) return n3.current = t4(), function() {
        return n3.current = null;
      };
    }, null == r3 ? r3 : r3.concat(n3));
  }
  function T2(n3, r3) {
    var u3 = p2(t2++, 7);
    return C2(u3.__H, r3) && (u3.__ = n3(), u3.__H = r3, u3.__h = n3), u3.__;
  }
  function q2(n3, t4) {
    return o2 = 8, T2(function() {
      return n3;
    }, t4);
  }
  function x2(n3) {
    var u3 = r2.context[n3.__c], i3 = p2(t2++, 9);
    return i3.c = n3, u3 ? (null == i3.__ && (i3.__ = true, u3.sub(r2)), u3.props.value) : n3.__;
  }
  function P2(n3, t4) {
    c2.useDebugValue && c2.useDebugValue(t4 ? t4(n3) : n3);
  }
  function g2() {
    var n3 = p2(t2++, 11);
    if (!n3.__) {
      for (var u3 = r2.__v; null !== u3 && !u3.__m && null !== u3.__; ) u3 = u3.__;
      var i3 = u3.__m || (u3.__m = [0, 0]);
      n3.__ = "P" + i3[0] + "-" + i3[1]++;
    }
    return n3.__;
  }
  function j2() {
    for (var n3; n3 = f2.shift(); ) if (n3.__P && n3.__H) try {
      n3.__H.__h.forEach(z2), n3.__H.__h.forEach(B2), n3.__H.__h = [];
    } catch (t4) {
      n3.__H.__h = [], c2.__e(t4, n3.__v);
    }
  }
  function w2(n3) {
    var t4, r3 = /* @__PURE__ */ __name(function() {
      clearTimeout(u3), k2 && cancelAnimationFrame(t4), setTimeout(n3);
    }, "r"), u3 = setTimeout(r3, 100);
    k2 && (t4 = requestAnimationFrame(r3));
  }
  function z2(n3) {
    var t4 = r2, u3 = n3.__c;
    "function" == typeof u3 && (n3.__c = void 0, u3()), r2 = t4;
  }
  function B2(n3) {
    var t4 = r2;
    n3.__c = n3.__(), r2 = t4;
  }
  function C2(n3, t4) {
    return !n3 || n3.length !== t4.length || t4.some(function(t5, r3) {
      return t5 !== n3[r3];
    });
  }
  function D2(n3, t4) {
    return "function" == typeof t4 ? t4(n3) : t4;
  }
  var t2, r2, u2, i2, o2, f2, c2, e2, a2, v2, l2, m2, s2, k2;
  var init_hooks_module = __esm({
    "node_modules/preact/hooks/dist/hooks.module.js"() {
      init_preact_module();
      o2 = 0;
      f2 = [];
      c2 = l;
      e2 = c2.__b;
      a2 = c2.__r;
      v2 = c2.diffed;
      l2 = c2.__c;
      m2 = c2.unmount;
      s2 = c2.__;
      __name(p2, "p");
      __name(d2, "d");
      __name(h2, "h");
      __name(y2, "y");
      __name(_2, "_");
      __name(A2, "A");
      __name(F2, "F");
      __name(T2, "T");
      __name(q2, "q");
      __name(x2, "x");
      __name(P2, "P");
      __name(g2, "g");
      __name(j2, "j");
      c2.__b = function(n3) {
        r2 = null, e2 && e2(n3);
      }, c2.__ = function(n3, t4) {
        n3 && t4.__k && t4.__k.__m && (n3.__m = t4.__k.__m), s2 && s2(n3, t4);
      }, c2.__r = function(n3) {
        a2 && a2(n3), t2 = 0;
        var i3 = (r2 = n3.__c).__H;
        i3 && (u2 === r2 ? (i3.__h = [], r2.__h = [], i3.__.forEach(function(n4) {
          n4.__N && (n4.__ = n4.__N), n4.u = n4.__N = void 0;
        })) : (i3.__h.forEach(z2), i3.__h.forEach(B2), i3.__h = [], t2 = 0)), u2 = r2;
      }, c2.diffed = function(n3) {
        v2 && v2(n3);
        var t4 = n3.__c;
        t4 && t4.__H && (t4.__H.__h.length && (1 !== f2.push(t4) && i2 === c2.requestAnimationFrame || ((i2 = c2.requestAnimationFrame) || w2)(j2)), t4.__H.__.forEach(function(n4) {
          n4.u && (n4.__H = n4.u), n4.u = void 0;
        })), u2 = r2 = null;
      }, c2.__c = function(n3, t4) {
        t4.some(function(n4) {
          try {
            n4.__h.forEach(z2), n4.__h = n4.__h.filter(function(n5) {
              return !n5.__ || B2(n5);
            });
          } catch (r3) {
            t4.some(function(n5) {
              n5.__h && (n5.__h = []);
            }), t4 = [], c2.__e(r3, n4.__v);
          }
        }), l2 && l2(n3, t4);
      }, c2.unmount = function(n3) {
        m2 && m2(n3);
        var t4, r3 = n3.__c;
        r3 && r3.__H && (r3.__H.__.forEach(function(n4) {
          try {
            z2(n4);
          } catch (n5) {
            t4 = n5;
          }
        }), r3.__H = void 0, t4 && c2.__e(t4, r3.__v));
      };
      k2 = "function" == typeof requestAnimationFrame;
      __name(w2, "w");
      __name(z2, "z");
      __name(B2, "B");
      __name(C2, "C");
      __name(D2, "D");
    }
  });

  // node_modules/htm/dist/htm.module.js
  function htm_module_default(s3) {
    var r3 = t3.get(this);
    return r3 || (r3 = /* @__PURE__ */ new Map(), t3.set(this, r3)), (r3 = n2(this, r3.get(s3) || (r3.set(s3, r3 = function(n3) {
      for (var t4, s4, r4 = 1, e3 = "", u3 = "", h3 = [0], p3 = function(n4) {
        1 === r4 && (n4 || (e3 = e3.replace(/^\s*\n\s*|\s*\n\s*$/g, ""))) ? h3.push(0, n4, e3) : 3 === r4 && (n4 || e3) ? (h3.push(3, n4, e3), r4 = 2) : 2 === r4 && "..." === e3 && n4 ? h3.push(4, n4, 0) : 2 === r4 && e3 && !n4 ? h3.push(5, 0, true, e3) : r4 >= 5 && ((e3 || !n4 && 5 === r4) && (h3.push(r4, 0, e3, s4), r4 = 6), n4 && (h3.push(r4, n4, 0, s4), r4 = 6)), e3 = "";
      }, a3 = 0; a3 < n3.length; a3++) {
        a3 && (1 === r4 && p3(), p3(a3));
        for (var l3 = 0; l3 < n3[a3].length; l3++) t4 = n3[a3][l3], 1 === r4 ? "<" === t4 ? (p3(), h3 = [h3], r4 = 3) : e3 += t4 : 4 === r4 ? "--" === e3 && ">" === t4 ? (r4 = 1, e3 = "") : e3 = t4 + e3[0] : u3 ? t4 === u3 ? u3 = "" : e3 += t4 : '"' === t4 || "'" === t4 ? u3 = t4 : ">" === t4 ? (p3(), r4 = 1) : r4 && ("=" === t4 ? (r4 = 5, s4 = e3, e3 = "") : "/" === t4 && (r4 < 5 || ">" === n3[a3][l3 + 1]) ? (p3(), 3 === r4 && (h3 = h3[0]), r4 = h3, (h3 = h3[0]).push(2, 0, r4), r4 = 0) : " " === t4 || "	" === t4 || "\n" === t4 || "\r" === t4 ? (p3(), r4 = 2) : e3 += t4), 3 === r4 && "!--" === e3 && (r4 = 4, h3 = h3[0]);
      }
      return p3(), h3;
    }(s3)), r3), arguments, [])).length > 1 ? r3 : r3[0];
  }
  var n2, t3;
  var init_htm_module = __esm({
    "node_modules/htm/dist/htm.module.js"() {
      n2 = /* @__PURE__ */ __name(function(t4, s3, r3, e3) {
        var u3;
        s3[0] = 0;
        for (var h3 = 1; h3 < s3.length; h3++) {
          var p3 = s3[h3++], a3 = s3[h3] ? (s3[0] |= p3 ? 1 : 2, r3[s3[h3++]]) : s3[++h3];
          3 === p3 ? e3[0] = a3 : 4 === p3 ? e3[1] = Object.assign(e3[1] || {}, a3) : 5 === p3 ? (e3[1] = e3[1] || {})[s3[++h3]] = a3 : 6 === p3 ? e3[1][s3[++h3]] += a3 + "" : p3 ? (u3 = t4.apply(a3, n2(t4, a3, r3, ["", null])), e3.push(u3), a3[0] ? s3[0] |= 2 : (s3[h3 - 2] = 0, s3[h3] = u3)) : e3.push(a3);
        }
        return e3;
      }, "n");
      t3 = /* @__PURE__ */ new Map();
      __name(htm_module_default, "default");
    }
  });

  // node_modules/preact-iso/src/router.js
  function LocationProvider(props) {
    const [url, route] = h2(UPDATE, props.url || location.pathname + location.search);
    if (props.scope) scope = props.scope;
    const wasPush = push === true;
    const value = T2(() => {
      const u3 = new URL(url, location.origin);
      const path = u3.pathname.replace(/\/+$/g, "") || "/";
      return {
        url,
        path,
        query: Object.fromEntries(u3.searchParams),
        route: /* @__PURE__ */ __name((url2, replace) => route({ url: url2, replace }), "route"),
        wasPush
      };
    }, [url]);
    _2(() => {
      addEventListener("click", route);
      addEventListener("popstate", route);
      return () => {
        removeEventListener("click", route);
        removeEventListener("popstate", route);
      };
    }, []);
    return _(LocationProvider.ctx.Provider, { value }, props.children);
  }
  function Router(props) {
    const [c3, update] = h2((c4) => c4 + 1, 0);
    const { url, query, wasPush, path } = useLocation();
    const { rest = path, params = {} } = x2(RouteContext);
    const isLoading = A2(false);
    const prevRoute = A2(path);
    const count = A2(0);
    const cur = (
      /** @type {RefObject<VNode<any>>} */
      A2()
    );
    const prev = (
      /** @type {RefObject<VNode<any>>} */
      A2()
    );
    const pendingBase = (
      /** @type {RefObject<Element | Text>} */
      A2()
    );
    const hasEverCommitted = A2(false);
    const didSuspend = (
      /** @type {RefObject<boolean>} */
      A2()
    );
    didSuspend.current = false;
    const routeChanged = A2(false);
    let pathRoute, defaultRoute, matchProps;
    H(props.children).some((vnode) => {
      const matches = exec(rest, vnode.props.path, matchProps = { ...vnode.props, path: rest, query, params, rest: "" });
      if (matches) return pathRoute = G(vnode, matchProps);
      if (vnode.props.default) defaultRoute = G(vnode, matchProps);
    });
    let incoming = pathRoute || defaultRoute;
    T2(() => {
      prev.current = cur.current;
      const outgoing = prev.current && prev.current.props.children;
      if (!outgoing || !incoming || incoming.type !== outgoing.type || incoming.props.component !== outgoing.props.component) {
        if (this.__v && this.__v.__k) this.__v.__k.reverse();
        count.current++;
        routeChanged.current = true;
      } else routeChanged.current = false;
    }, [url]);
    const isHydratingSuspense = cur.current && cur.current.__u & MODE_HYDRATE && cur.current.__u & MODE_SUSPENDED;
    const isHydratingBool = cur.current && cur.current.__h;
    cur.current = /** @type {VNode<any>} */
    _(RouteContext.Provider, { value: matchProps }, incoming);
    if (isHydratingSuspense) {
      cur.current.__u |= MODE_HYDRATE;
      cur.current.__u |= MODE_SUSPENDED;
    } else if (isHydratingBool) {
      cur.current.__h = true;
    }
    const p3 = prev.current;
    prev.current = null;
    this.__c = (e3, suspendedVNode) => {
      didSuspend.current = true;
      prev.current = p3;
      if (props.onLoadStart) props.onLoadStart(url);
      isLoading.current = true;
      let c4 = count.current;
      e3.then(() => {
        if (c4 !== count.current) return;
        prev.current = null;
        if (cur.current) {
          if (suspendedVNode.__h) {
            cur.current.__h = suspendedVNode.__h;
          }
          if (suspendedVNode.__u & MODE_SUSPENDED) {
            cur.current.__u |= MODE_SUSPENDED;
          }
          if (suspendedVNode.__u & MODE_HYDRATE) {
            cur.current.__u |= MODE_HYDRATE;
          }
        }
        RESOLVED.then(update);
      });
    };
    _2(() => {
      const currentDom = this.__v && this.__v.__e;
      if (didSuspend.current) {
        if (!hasEverCommitted.current && !pendingBase.current) {
          pendingBase.current = currentDom;
        }
        return;
      }
      if (!hasEverCommitted.current && pendingBase.current) {
        if (pendingBase.current !== currentDom) pendingBase.current.remove();
        pendingBase.current = null;
      }
      hasEverCommitted.current = true;
      if (prevRoute.current !== path) {
        if (wasPush) scrollTo(0, 0);
        if (props.onRouteChange) props.onRouteChange(url);
        prevRoute.current = path;
      }
      if (props.onLoadEnd && isLoading.current) props.onLoadEnd(url);
      isLoading.current = false;
    }, [path, wasPush, c3]);
    return routeChanged.current ? [_(RenderRef, { r: cur }), _(RenderRef, { r: prev })] : _(RenderRef, { r: cur });
  }
  var push, scope, UPDATE, exec, RESOLVED, MODE_HYDRATE, MODE_SUSPENDED, RenderRef, RouteContext, Route, useLocation;
  var init_router = __esm({
    "node_modules/preact-iso/src/router.js"() {
      init_preact_module();
      init_hooks_module();
      UPDATE = /* @__PURE__ */ __name((state, url) => {
        push = void 0;
        if (url && url.type === "click") {
          if (url.ctrlKey || url.metaKey || url.altKey || url.shiftKey || url.button !== 0) {
            return state;
          }
          const link2 = url.target.closest("a[href]"), href = link2 && link2.getAttribute("href");
          if (!link2 || link2.origin != location.origin || /^#/.test(href) || !/^(_?self)?$/i.test(link2.target) || scope && (typeof scope == "string" ? !href.startsWith(scope) : !scope.test(href))) {
            return state;
          }
          push = true;
          url.preventDefault();
          url = link2.href.replace(location.origin, "");
        } else if (typeof url === "string") {
          push = true;
        } else if (url && url.url) {
          push = !url.replace;
          url = url.url;
        } else {
          url = location.pathname + location.search;
        }
        if (push === true) history.pushState(null, "", url);
        else if (push === false) history.replaceState(null, "", url);
        return url;
      }, "UPDATE");
      exec = /* @__PURE__ */ __name((url, route, matches = {}) => {
        url = url.split("/").filter(Boolean);
        route = (route || "").split("/").filter(Boolean);
        if (!matches.params) matches.params = {};
        for (let i3 = 0, val, rest; i3 < Math.max(url.length, route.length); i3++) {
          let [, m3, param, flag] = (route[i3] || "").match(/^(:?)(.*?)([+*?]?)$/);
          val = url[i3];
          if (!m3 && param == val) continue;
          if (!m3 && val && flag == "*") {
            matches.rest = "/" + url.slice(i3).map(decodeURIComponent).join("/");
            break;
          }
          if (!m3 || !val && flag != "?" && flag != "*") return;
          rest = flag == "+" || flag == "*";
          if (rest) val = url.slice(i3).map(decodeURIComponent).join("/") || void 0;
          else if (val) val = decodeURIComponent(val);
          matches.params[param] = val;
          if (!(param in matches)) matches[param] = val;
          if (rest) break;
        }
        return matches;
      }, "exec");
      __name(LocationProvider, "LocationProvider");
      RESOLVED = Promise.resolve();
      __name(Router, "Router");
      MODE_HYDRATE = 1 << 5;
      MODE_SUSPENDED = 1 << 7;
      RenderRef = /* @__PURE__ */ __name(({ r: r3 }) => r3.current, "RenderRef");
      Router.Provider = LocationProvider;
      LocationProvider.ctx = J(
        /** @type {import('./router.d.ts').LocationHook & { wasPush: boolean }} */
        {}
      );
      RouteContext = J(
        /** @type {import('./router.d.ts').RouteHook & { rest: string }} */
        {}
      );
      Route = /* @__PURE__ */ __name((props) => _(props.component, props), "Route");
      useLocation = /* @__PURE__ */ __name(() => x2(LocationProvider.ctx), "useLocation");
    }
  });

  // node_modules/preact-iso/src/lazy.js
  function lazy(load) {
    let p3, c3;
    const loadModule = /* @__PURE__ */ __name(() => load().then((m3) => c3 = m3 && m3.default || m3), "loadModule");
    const LazyComponent = /* @__PURE__ */ __name((props) => {
      const [, update] = d2(0);
      const r3 = A2(c3);
      if (!p3) p3 = loadModule();
      if (c3 !== void 0) return _(c3, props);
      if (!r3.current) r3.current = p3.then(() => update(1));
      throw p3;
    }, "LazyComponent");
    LazyComponent.preload = () => {
      if (!p3) p3 = loadModule();
      return p3;
    };
    LazyComponent._forwarded = true;
    return LazyComponent;
  }
  function ErrorBoundary(props) {
    this.__c = childDidSuspend;
    this.componentDidCatch = props.onError;
    return props.children;
  }
  function childDidSuspend(err) {
    err.then(() => this.forceUpdate());
  }
  var oldDiff, oldCatchError;
  var init_lazy = __esm({
    "node_modules/preact-iso/src/lazy.js"() {
      init_preact_module();
      init_hooks_module();
      oldDiff = l.__b;
      l.__b = (vnode) => {
        if (vnode.type && vnode.type._forwarded && vnode.ref) {
          vnode.props.ref = vnode.ref;
          vnode.ref = null;
        }
        if (oldDiff) oldDiff(vnode);
      };
      __name(lazy, "lazy");
      oldCatchError = l.__e;
      l.__e = (err, newVNode, oldVNode) => {
        if (err && err.then) {
          let v3 = newVNode;
          while (v3 = v3.__) {
            if (v3.__c && v3.__c.__c) {
              if (newVNode.__e == null) {
                newVNode.__e = oldVNode.__e;
                newVNode.__k = oldVNode.__k;
              }
              if (!newVNode.__k) newVNode.__k = [];
              return v3.__c.__c(err, newVNode);
            }
          }
        }
        if (oldCatchError) oldCatchError(err, newVNode, oldVNode);
      };
      __name(ErrorBoundary, "ErrorBoundary");
      __name(childDidSuspend, "childDidSuspend");
    }
  });

  // node_modules/preact-iso/src/hydrate.js
  var init_hydrate = __esm({
    "node_modules/preact-iso/src/hydrate.js"() {
      init_preact_module();
    }
  });

  // node_modules/preact-iso/src/index.js
  var init_src = __esm({
    "node_modules/preact-iso/src/index.js"() {
      init_router();
      init_lazy();
      init_hydrate();
    }
  });

  // node_modules/dexie/dist/dexie.js
  var require_dexie = __commonJS({
    "node_modules/dexie/dist/dexie.js"(exports, module) {
      (function(global2, factory) {
        typeof exports === "object" && typeof module !== "undefined" ? module.exports = factory() : typeof define === "function" && define.amd ? define(factory) : (global2 = typeof globalThis !== "undefined" ? globalThis : global2 || self, global2.Dexie = factory());
      })(exports, function() {
        "use strict";
        /*! *****************************************************************************
        Copyright (c) Microsoft Corporation.
        Permission to use, copy, modify, and/or distribute this software for any
        purpose with or without fee is hereby granted.
        THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
        REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
        AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
        INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
        LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
        OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
        PERFORMANCE OF THIS SOFTWARE.
        ***************************************************************************** */
        var extendStatics = /* @__PURE__ */ __name(function(d3, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d4, b3) {
            d4.__proto__ = b3;
          } || function(d4, b3) {
            for (var p3 in b3) if (Object.prototype.hasOwnProperty.call(b3, p3)) d4[p3] = b3[p3];
          };
          return extendStatics(d3, b2);
        }, "extendStatics");
        function __extends(d3, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String(b2) + " is not a constructor or null");
          extendStatics(d3, b2);
          function __() {
            this.constructor = d3;
          }
          __name(__, "__");
          d3.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        }
        __name(__extends, "__extends");
        var __assign = /* @__PURE__ */ __name(function() {
          __assign = Object.assign || /* @__PURE__ */ __name(function __assign2(t4) {
            for (var s3, i3 = 1, n3 = arguments.length; i3 < n3; i3++) {
              s3 = arguments[i3];
              for (var p3 in s3) if (Object.prototype.hasOwnProperty.call(s3, p3)) t4[p3] = s3[p3];
            }
            return t4;
          }, "__assign");
          return __assign.apply(this, arguments);
        }, "__assign");
        function __spreadArray(to, from, pack) {
          if (pack || arguments.length === 2) for (var i3 = 0, l3 = from.length, ar; i3 < l3; i3++) {
            if (ar || !(i3 in from)) {
              if (!ar) ar = Array.prototype.slice.call(from, 0, i3);
              ar[i3] = from[i3];
            }
          }
          return to.concat(ar || Array.prototype.slice.call(from));
        }
        __name(__spreadArray, "__spreadArray");
        var _global = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : global;
        var keys = Object.keys;
        var isArray = Array.isArray;
        if (typeof Promise !== "undefined" && !_global.Promise) {
          _global.Promise = Promise;
        }
        function extend(obj, extension) {
          if (typeof extension !== "object")
            return obj;
          keys(extension).forEach(function(key2) {
            obj[key2] = extension[key2];
          });
          return obj;
        }
        __name(extend, "extend");
        var getProto = Object.getPrototypeOf;
        var _hasOwn = {}.hasOwnProperty;
        function hasOwn(obj, prop) {
          return _hasOwn.call(obj, prop);
        }
        __name(hasOwn, "hasOwn");
        function props(proto, extension) {
          if (typeof extension === "function")
            extension = extension(getProto(proto));
          (typeof Reflect === "undefined" ? keys : Reflect.ownKeys)(extension).forEach(function(key2) {
            setProp(proto, key2, extension[key2]);
          });
        }
        __name(props, "props");
        var defineProperty = Object.defineProperty;
        function setProp(obj, prop, functionOrGetSet, options2) {
          defineProperty(obj, prop, extend(functionOrGetSet && hasOwn(functionOrGetSet, "get") && typeof functionOrGetSet.get === "function" ? { get: functionOrGetSet.get, set: functionOrGetSet.set, configurable: true } : { value: functionOrGetSet, configurable: true, writable: true }, options2));
        }
        __name(setProp, "setProp");
        function derive(Child) {
          return {
            from: /* @__PURE__ */ __name(function(Parent) {
              Child.prototype = Object.create(Parent.prototype);
              setProp(Child.prototype, "constructor", Child);
              return {
                extend: props.bind(null, Child.prototype)
              };
            }, "from")
          };
        }
        __name(derive, "derive");
        var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
        function getPropertyDescriptor(obj, prop) {
          var pd = getOwnPropertyDescriptor(obj, prop);
          var proto;
          return pd || (proto = getProto(obj)) && getPropertyDescriptor(proto, prop);
        }
        __name(getPropertyDescriptor, "getPropertyDescriptor");
        var _slice = [].slice;
        function slice(args, start, end) {
          return _slice.call(args, start, end);
        }
        __name(slice, "slice");
        function override(origFunc, overridedFactory) {
          return overridedFactory(origFunc);
        }
        __name(override, "override");
        function assert(b2) {
          if (!b2)
            throw new Error("Assertion Failed");
        }
        __name(assert, "assert");
        function asap$1(fn2) {
          if (_global.setImmediate)
            setImmediate(fn2);
          else
            setTimeout(fn2, 0);
        }
        __name(asap$1, "asap$1");
        function arrayToObject(array, extractor) {
          return array.reduce(function(result, item, i3) {
            var nameAndValue = extractor(item, i3);
            if (nameAndValue)
              result[nameAndValue[0]] = nameAndValue[1];
            return result;
          }, {});
        }
        __name(arrayToObject, "arrayToObject");
        function getByKeyPath(obj, keyPath) {
          if (typeof keyPath === "string" && hasOwn(obj, keyPath))
            return obj[keyPath];
          if (!keyPath)
            return obj;
          if (typeof keyPath !== "string") {
            var rv = [];
            for (var i3 = 0, l3 = keyPath.length; i3 < l3; ++i3) {
              var val = getByKeyPath(obj, keyPath[i3]);
              rv.push(val);
            }
            return rv;
          }
          var period = keyPath.indexOf(".");
          if (period !== -1) {
            var innerObj = obj[keyPath.substr(0, period)];
            return innerObj == null ? void 0 : getByKeyPath(innerObj, keyPath.substr(period + 1));
          }
          return void 0;
        }
        __name(getByKeyPath, "getByKeyPath");
        function setByKeyPath(obj, keyPath, value) {
          if (!obj || keyPath === void 0)
            return;
          if ("isFrozen" in Object && Object.isFrozen(obj))
            return;
          if (typeof keyPath !== "string" && "length" in keyPath) {
            assert(typeof value !== "string" && "length" in value);
            for (var i3 = 0, l3 = keyPath.length; i3 < l3; ++i3) {
              setByKeyPath(obj, keyPath[i3], value[i3]);
            }
          } else {
            var period = keyPath.indexOf(".");
            if (period !== -1) {
              var currentKeyPath = keyPath.substr(0, period);
              var remainingKeyPath = keyPath.substr(period + 1);
              if (remainingKeyPath === "")
                if (value === void 0) {
                  if (isArray(obj) && !isNaN(parseInt(currentKeyPath)))
                    obj.splice(currentKeyPath, 1);
                  else
                    delete obj[currentKeyPath];
                } else
                  obj[currentKeyPath] = value;
              else {
                var innerObj = obj[currentKeyPath];
                if (!innerObj || !hasOwn(obj, currentKeyPath))
                  innerObj = obj[currentKeyPath] = {};
                setByKeyPath(innerObj, remainingKeyPath, value);
              }
            } else {
              if (value === void 0) {
                if (isArray(obj) && !isNaN(parseInt(keyPath)))
                  obj.splice(keyPath, 1);
                else
                  delete obj[keyPath];
              } else
                obj[keyPath] = value;
            }
          }
        }
        __name(setByKeyPath, "setByKeyPath");
        function delByKeyPath(obj, keyPath) {
          if (typeof keyPath === "string")
            setByKeyPath(obj, keyPath, void 0);
          else if ("length" in keyPath)
            [].map.call(keyPath, function(kp) {
              setByKeyPath(obj, kp, void 0);
            });
        }
        __name(delByKeyPath, "delByKeyPath");
        function shallowClone(obj) {
          var rv = {};
          for (var m3 in obj) {
            if (hasOwn(obj, m3))
              rv[m3] = obj[m3];
          }
          return rv;
        }
        __name(shallowClone, "shallowClone");
        var concat = [].concat;
        function flatten(a3) {
          return concat.apply([], a3);
        }
        __name(flatten, "flatten");
        var intrinsicTypeNames = "BigUint64Array,BigInt64Array,Array,Boolean,String,Date,RegExp,Blob,File,FileList,FileSystemFileHandle,FileSystemDirectoryHandle,ArrayBuffer,DataView,Uint8ClampedArray,ImageBitmap,ImageData,Map,Set,CryptoKey".split(",").concat(flatten([8, 16, 32, 64].map(function(num) {
          return ["Int", "Uint", "Float"].map(function(t4) {
            return t4 + num + "Array";
          });
        }))).filter(function(t4) {
          return _global[t4];
        });
        var intrinsicTypes = new Set(intrinsicTypeNames.map(function(t4) {
          return _global[t4];
        }));
        function cloneSimpleObjectTree(o3) {
          var rv = {};
          for (var k4 in o3)
            if (hasOwn(o3, k4)) {
              var v3 = o3[k4];
              rv[k4] = !v3 || typeof v3 !== "object" || intrinsicTypes.has(v3.constructor) ? v3 : cloneSimpleObjectTree(v3);
            }
          return rv;
        }
        __name(cloneSimpleObjectTree, "cloneSimpleObjectTree");
        function objectIsEmpty(o3) {
          for (var k4 in o3)
            if (hasOwn(o3, k4))
              return false;
          return true;
        }
        __name(objectIsEmpty, "objectIsEmpty");
        var circularRefs = null;
        function deepClone(any) {
          circularRefs = /* @__PURE__ */ new WeakMap();
          var rv = innerDeepClone(any);
          circularRefs = null;
          return rv;
        }
        __name(deepClone, "deepClone");
        function innerDeepClone(x4) {
          if (!x4 || typeof x4 !== "object")
            return x4;
          var rv = circularRefs.get(x4);
          if (rv)
            return rv;
          if (isArray(x4)) {
            rv = [];
            circularRefs.set(x4, rv);
            for (var i3 = 0, l3 = x4.length; i3 < l3; ++i3) {
              rv.push(innerDeepClone(x4[i3]));
            }
          } else if (intrinsicTypes.has(x4.constructor)) {
            rv = x4;
          } else {
            var proto = getProto(x4);
            rv = proto === Object.prototype ? {} : Object.create(proto);
            circularRefs.set(x4, rv);
            for (var prop in x4) {
              if (hasOwn(x4, prop)) {
                rv[prop] = innerDeepClone(x4[prop]);
              }
            }
          }
          return rv;
        }
        __name(innerDeepClone, "innerDeepClone");
        var toString = {}.toString;
        function toStringTag(o3) {
          return toString.call(o3).slice(8, -1);
        }
        __name(toStringTag, "toStringTag");
        var iteratorSymbol = typeof Symbol !== "undefined" ? Symbol.iterator : "@@iterator";
        var getIteratorOf = typeof iteratorSymbol === "symbol" ? function(x4) {
          var i3;
          return x4 != null && (i3 = x4[iteratorSymbol]) && i3.apply(x4);
        } : function() {
          return null;
        };
        function delArrayItem(a3, x4) {
          var i3 = a3.indexOf(x4);
          if (i3 >= 0)
            a3.splice(i3, 1);
          return i3 >= 0;
        }
        __name(delArrayItem, "delArrayItem");
        var NO_CHAR_ARRAY = {};
        function getArrayOf(arrayLike) {
          var i3, a3, x4, it;
          if (arguments.length === 1) {
            if (isArray(arrayLike))
              return arrayLike.slice();
            if (this === NO_CHAR_ARRAY && typeof arrayLike === "string")
              return [arrayLike];
            if (it = getIteratorOf(arrayLike)) {
              a3 = [];
              while (x4 = it.next(), !x4.done)
                a3.push(x4.value);
              return a3;
            }
            if (arrayLike == null)
              return [arrayLike];
            i3 = arrayLike.length;
            if (typeof i3 === "number") {
              a3 = new Array(i3);
              while (i3--)
                a3[i3] = arrayLike[i3];
              return a3;
            }
            return [arrayLike];
          }
          i3 = arguments.length;
          a3 = new Array(i3);
          while (i3--)
            a3[i3] = arguments[i3];
          return a3;
        }
        __name(getArrayOf, "getArrayOf");
        var isAsyncFunction = typeof Symbol !== "undefined" ? function(fn2) {
          return fn2[Symbol.toStringTag] === "AsyncFunction";
        } : function() {
          return false;
        };
        var dexieErrorNames = [
          "Modify",
          "Bulk",
          "OpenFailed",
          "VersionChange",
          "Schema",
          "Upgrade",
          "InvalidTable",
          "MissingAPI",
          "NoSuchDatabase",
          "InvalidArgument",
          "SubTransaction",
          "Unsupported",
          "Internal",
          "DatabaseClosed",
          "PrematureCommit",
          "ForeignAwait"
        ];
        var idbDomErrorNames = [
          "Unknown",
          "Constraint",
          "Data",
          "TransactionInactive",
          "ReadOnly",
          "Version",
          "NotFound",
          "InvalidState",
          "InvalidAccess",
          "Abort",
          "Timeout",
          "QuotaExceeded",
          "Syntax",
          "DataClone"
        ];
        var errorList = dexieErrorNames.concat(idbDomErrorNames);
        var defaultTexts = {
          VersionChanged: "Database version changed by other database connection",
          DatabaseClosed: "Database has been closed",
          Abort: "Transaction aborted",
          TransactionInactive: "Transaction has already completed or failed",
          MissingAPI: "IndexedDB API missing. Please visit https://tinyurl.com/y2uuvskb"
        };
        function DexieError(name, msg) {
          this.name = name;
          this.message = msg;
        }
        __name(DexieError, "DexieError");
        derive(DexieError).from(Error).extend({
          toString: /* @__PURE__ */ __name(function() {
            return this.name + ": " + this.message;
          }, "toString")
        });
        function getMultiErrorMessage(msg, failures) {
          return msg + ". Errors: " + Object.keys(failures).map(function(key2) {
            return failures[key2].toString();
          }).filter(function(v3, i3, s3) {
            return s3.indexOf(v3) === i3;
          }).join("\n");
        }
        __name(getMultiErrorMessage, "getMultiErrorMessage");
        function ModifyError(msg, failures, successCount, failedKeys) {
          this.failures = failures;
          this.failedKeys = failedKeys;
          this.successCount = successCount;
          this.message = getMultiErrorMessage(msg, failures);
        }
        __name(ModifyError, "ModifyError");
        derive(ModifyError).from(DexieError);
        function BulkError(msg, failures) {
          this.name = "BulkError";
          this.failures = Object.keys(failures).map(function(pos) {
            return failures[pos];
          });
          this.failuresByPos = failures;
          this.message = getMultiErrorMessage(msg, this.failures);
        }
        __name(BulkError, "BulkError");
        derive(BulkError).from(DexieError);
        var errnames = errorList.reduce(function(obj, name) {
          return obj[name] = name + "Error", obj;
        }, {});
        var BaseException = DexieError;
        var exceptions = errorList.reduce(function(obj, name) {
          var fullName = name + "Error";
          function DexieError2(msgOrInner, inner) {
            this.name = fullName;
            if (!msgOrInner) {
              this.message = defaultTexts[name] || fullName;
              this.inner = null;
            } else if (typeof msgOrInner === "string") {
              this.message = "".concat(msgOrInner).concat(!inner ? "" : "\n " + inner);
              this.inner = inner || null;
            } else if (typeof msgOrInner === "object") {
              this.message = "".concat(msgOrInner.name, " ").concat(msgOrInner.message);
              this.inner = msgOrInner;
            }
          }
          __name(DexieError2, "DexieError");
          derive(DexieError2).from(BaseException);
          obj[name] = DexieError2;
          return obj;
        }, {});
        exceptions.Syntax = SyntaxError;
        exceptions.Type = TypeError;
        exceptions.Range = RangeError;
        var exceptionMap = idbDomErrorNames.reduce(function(obj, name) {
          obj[name + "Error"] = exceptions[name];
          return obj;
        }, {});
        function mapError(domError, message) {
          if (!domError || domError instanceof DexieError || domError instanceof TypeError || domError instanceof SyntaxError || !domError.name || !exceptionMap[domError.name])
            return domError;
          var rv = new exceptionMap[domError.name](message || domError.message, domError);
          if ("stack" in domError) {
            setProp(rv, "stack", { get: /* @__PURE__ */ __name(function() {
              return this.inner.stack;
            }, "get") });
          }
          return rv;
        }
        __name(mapError, "mapError");
        var fullNameExceptions = errorList.reduce(function(obj, name) {
          if (["Syntax", "Type", "Range"].indexOf(name) === -1)
            obj[name + "Error"] = exceptions[name];
          return obj;
        }, {});
        fullNameExceptions.ModifyError = ModifyError;
        fullNameExceptions.DexieError = DexieError;
        fullNameExceptions.BulkError = BulkError;
        function nop() {
        }
        __name(nop, "nop");
        function mirror(val) {
          return val;
        }
        __name(mirror, "mirror");
        function pureFunctionChain(f1, f22) {
          if (f1 == null || f1 === mirror)
            return f22;
          return function(val) {
            return f22(f1(val));
          };
        }
        __name(pureFunctionChain, "pureFunctionChain");
        function callBoth(on1, on2) {
          return function() {
            on1.apply(this, arguments);
            on2.apply(this, arguments);
          };
        }
        __name(callBoth, "callBoth");
        function hookCreatingChain(f1, f22) {
          if (f1 === nop)
            return f22;
          return function() {
            var res = f1.apply(this, arguments);
            if (res !== void 0)
              arguments[0] = res;
            var onsuccess = this.onsuccess, onerror = this.onerror;
            this.onsuccess = null;
            this.onerror = null;
            var res2 = f22.apply(this, arguments);
            if (onsuccess)
              this.onsuccess = this.onsuccess ? callBoth(onsuccess, this.onsuccess) : onsuccess;
            if (onerror)
              this.onerror = this.onerror ? callBoth(onerror, this.onerror) : onerror;
            return res2 !== void 0 ? res2 : res;
          };
        }
        __name(hookCreatingChain, "hookCreatingChain");
        function hookDeletingChain(f1, f22) {
          if (f1 === nop)
            return f22;
          return function() {
            f1.apply(this, arguments);
            var onsuccess = this.onsuccess, onerror = this.onerror;
            this.onsuccess = this.onerror = null;
            f22.apply(this, arguments);
            if (onsuccess)
              this.onsuccess = this.onsuccess ? callBoth(onsuccess, this.onsuccess) : onsuccess;
            if (onerror)
              this.onerror = this.onerror ? callBoth(onerror, this.onerror) : onerror;
          };
        }
        __name(hookDeletingChain, "hookDeletingChain");
        function hookUpdatingChain(f1, f22) {
          if (f1 === nop)
            return f22;
          return function(modifications) {
            var res = f1.apply(this, arguments);
            extend(modifications, res);
            var onsuccess = this.onsuccess, onerror = this.onerror;
            this.onsuccess = null;
            this.onerror = null;
            var res2 = f22.apply(this, arguments);
            if (onsuccess)
              this.onsuccess = this.onsuccess ? callBoth(onsuccess, this.onsuccess) : onsuccess;
            if (onerror)
              this.onerror = this.onerror ? callBoth(onerror, this.onerror) : onerror;
            return res === void 0 ? res2 === void 0 ? void 0 : res2 : extend(res, res2);
          };
        }
        __name(hookUpdatingChain, "hookUpdatingChain");
        function reverseStoppableEventChain(f1, f22) {
          if (f1 === nop)
            return f22;
          return function() {
            if (f22.apply(this, arguments) === false)
              return false;
            return f1.apply(this, arguments);
          };
        }
        __name(reverseStoppableEventChain, "reverseStoppableEventChain");
        function promisableChain(f1, f22) {
          if (f1 === nop)
            return f22;
          return function() {
            var res = f1.apply(this, arguments);
            if (res && typeof res.then === "function") {
              var thiz = this, i3 = arguments.length, args = new Array(i3);
              while (i3--)
                args[i3] = arguments[i3];
              return res.then(function() {
                return f22.apply(thiz, args);
              });
            }
            return f22.apply(this, arguments);
          };
        }
        __name(promisableChain, "promisableChain");
        var debug = typeof location !== "undefined" && /^(http|https):\/\/(localhost|127\.0\.0\.1)/.test(location.href);
        function setDebug(value, filter) {
          debug = value;
        }
        __name(setDebug, "setDebug");
        var INTERNAL = {};
        var ZONE_ECHO_LIMIT = 100, _a$1 = typeof Promise === "undefined" ? [] : function() {
          var globalP = Promise.resolve();
          if (typeof crypto === "undefined" || !crypto.subtle)
            return [globalP, getProto(globalP), globalP];
          var nativeP = crypto.subtle.digest("SHA-512", new Uint8Array([0]));
          return [
            nativeP,
            getProto(nativeP),
            globalP
          ];
        }(), resolvedNativePromise = _a$1[0], nativePromiseProto = _a$1[1], resolvedGlobalPromise = _a$1[2], nativePromiseThen = nativePromiseProto && nativePromiseProto.then;
        var NativePromise = resolvedNativePromise && resolvedNativePromise.constructor;
        var patchGlobalPromise = !!resolvedGlobalPromise;
        function schedulePhysicalTick() {
          queueMicrotask(physicalTick);
        }
        __name(schedulePhysicalTick, "schedulePhysicalTick");
        var asap = /* @__PURE__ */ __name(function(callback, args) {
          microtickQueue.push([callback, args]);
          if (needsNewPhysicalTick) {
            schedulePhysicalTick();
            needsNewPhysicalTick = false;
          }
        }, "asap");
        var isOutsideMicroTick = true, needsNewPhysicalTick = true, unhandledErrors = [], rejectingErrors = [], rejectionMapper = mirror;
        var globalPSD = {
          id: "global",
          global: true,
          ref: 0,
          unhandleds: [],
          onunhandled: nop,
          pgp: false,
          env: {},
          finalize: nop
        };
        var PSD = globalPSD;
        var microtickQueue = [];
        var numScheduledCalls = 0;
        var tickFinalizers = [];
        function DexiePromise(fn2) {
          if (typeof this !== "object")
            throw new TypeError("Promises must be constructed via new");
          this._listeners = [];
          this._lib = false;
          var psd = this._PSD = PSD;
          if (typeof fn2 !== "function") {
            if (fn2 !== INTERNAL)
              throw new TypeError("Not a function");
            this._state = arguments[1];
            this._value = arguments[2];
            if (this._state === false)
              handleRejection(this, this._value);
            return;
          }
          this._state = null;
          this._value = null;
          ++psd.ref;
          executePromiseTask(this, fn2);
        }
        __name(DexiePromise, "DexiePromise");
        var thenProp = {
          get: /* @__PURE__ */ __name(function() {
            var psd = PSD, microTaskId = totalEchoes;
            function then(onFulfilled, onRejected) {
              var _this = this;
              var possibleAwait = !psd.global && (psd !== PSD || microTaskId !== totalEchoes);
              var cleanup = possibleAwait && !decrementExpectedAwaits();
              var rv = new DexiePromise(function(resolve, reject) {
                propagateToListener(_this, new Listener(nativeAwaitCompatibleWrap(onFulfilled, psd, possibleAwait, cleanup), nativeAwaitCompatibleWrap(onRejected, psd, possibleAwait, cleanup), resolve, reject, psd));
              });
              if (this._consoleTask)
                rv._consoleTask = this._consoleTask;
              return rv;
            }
            __name(then, "then");
            then.prototype = INTERNAL;
            return then;
          }, "get"),
          set: /* @__PURE__ */ __name(function(value) {
            setProp(this, "then", value && value.prototype === INTERNAL ? thenProp : {
              get: /* @__PURE__ */ __name(function() {
                return value;
              }, "get"),
              set: thenProp.set
            });
          }, "set")
        };
        props(DexiePromise.prototype, {
          then: thenProp,
          _then: /* @__PURE__ */ __name(function(onFulfilled, onRejected) {
            propagateToListener(this, new Listener(null, null, onFulfilled, onRejected, PSD));
          }, "_then"),
          catch: /* @__PURE__ */ __name(function(onRejected) {
            if (arguments.length === 1)
              return this.then(null, onRejected);
            var type2 = arguments[0], handler = arguments[1];
            return typeof type2 === "function" ? this.then(null, function(err) {
              return err instanceof type2 ? handler(err) : PromiseReject(err);
            }) : this.then(null, function(err) {
              return err && err.name === type2 ? handler(err) : PromiseReject(err);
            });
          }, "catch"),
          finally: /* @__PURE__ */ __name(function(onFinally) {
            return this.then(function(value) {
              return DexiePromise.resolve(onFinally()).then(function() {
                return value;
              });
            }, function(err) {
              return DexiePromise.resolve(onFinally()).then(function() {
                return PromiseReject(err);
              });
            });
          }, "finally"),
          timeout: /* @__PURE__ */ __name(function(ms, msg) {
            var _this = this;
            return ms < Infinity ? new DexiePromise(function(resolve, reject) {
              var handle = setTimeout(function() {
                return reject(new exceptions.Timeout(msg));
              }, ms);
              _this.then(resolve, reject).finally(clearTimeout.bind(null, handle));
            }) : this;
          }, "timeout")
        });
        if (typeof Symbol !== "undefined" && Symbol.toStringTag)
          setProp(DexiePromise.prototype, Symbol.toStringTag, "Dexie.Promise");
        globalPSD.env = snapShot();
        function Listener(onFulfilled, onRejected, resolve, reject, zone) {
          this.onFulfilled = typeof onFulfilled === "function" ? onFulfilled : null;
          this.onRejected = typeof onRejected === "function" ? onRejected : null;
          this.resolve = resolve;
          this.reject = reject;
          this.psd = zone;
        }
        __name(Listener, "Listener");
        props(DexiePromise, {
          all: /* @__PURE__ */ __name(function() {
            var values = getArrayOf.apply(null, arguments).map(onPossibleParallellAsync);
            return new DexiePromise(function(resolve, reject) {
              if (values.length === 0)
                resolve([]);
              var remaining = values.length;
              values.forEach(function(a3, i3) {
                return DexiePromise.resolve(a3).then(function(x4) {
                  values[i3] = x4;
                  if (!--remaining)
                    resolve(values);
                }, reject);
              });
            });
          }, "all"),
          resolve: /* @__PURE__ */ __name(function(value) {
            if (value instanceof DexiePromise)
              return value;
            if (value && typeof value.then === "function")
              return new DexiePromise(function(resolve, reject) {
                value.then(resolve, reject);
              });
            var rv = new DexiePromise(INTERNAL, true, value);
            return rv;
          }, "resolve"),
          reject: PromiseReject,
          race: /* @__PURE__ */ __name(function() {
            var values = getArrayOf.apply(null, arguments).map(onPossibleParallellAsync);
            return new DexiePromise(function(resolve, reject) {
              values.map(function(value) {
                return DexiePromise.resolve(value).then(resolve, reject);
              });
            });
          }, "race"),
          PSD: {
            get: /* @__PURE__ */ __name(function() {
              return PSD;
            }, "get"),
            set: /* @__PURE__ */ __name(function(value) {
              return PSD = value;
            }, "set")
          },
          totalEchoes: { get: /* @__PURE__ */ __name(function() {
            return totalEchoes;
          }, "get") },
          newPSD: newScope,
          usePSD,
          scheduler: {
            get: /* @__PURE__ */ __name(function() {
              return asap;
            }, "get"),
            set: /* @__PURE__ */ __name(function(value) {
              asap = value;
            }, "set")
          },
          rejectionMapper: {
            get: /* @__PURE__ */ __name(function() {
              return rejectionMapper;
            }, "get"),
            set: /* @__PURE__ */ __name(function(value) {
              rejectionMapper = value;
            }, "set")
          },
          follow: /* @__PURE__ */ __name(function(fn2, zoneProps) {
            return new DexiePromise(function(resolve, reject) {
              return newScope(function(resolve2, reject2) {
                var psd = PSD;
                psd.unhandleds = [];
                psd.onunhandled = reject2;
                psd.finalize = callBoth(function() {
                  var _this = this;
                  run_at_end_of_this_or_next_physical_tick(function() {
                    _this.unhandleds.length === 0 ? resolve2() : reject2(_this.unhandleds[0]);
                  });
                }, psd.finalize);
                fn2();
              }, zoneProps, resolve, reject);
            });
          }, "follow")
        });
        if (NativePromise) {
          if (NativePromise.allSettled)
            setProp(DexiePromise, "allSettled", function() {
              var possiblePromises = getArrayOf.apply(null, arguments).map(onPossibleParallellAsync);
              return new DexiePromise(function(resolve) {
                if (possiblePromises.length === 0)
                  resolve([]);
                var remaining = possiblePromises.length;
                var results = new Array(remaining);
                possiblePromises.forEach(function(p3, i3) {
                  return DexiePromise.resolve(p3).then(function(value) {
                    return results[i3] = { status: "fulfilled", value };
                  }, function(reason) {
                    return results[i3] = { status: "rejected", reason };
                  }).then(function() {
                    return --remaining || resolve(results);
                  });
                });
              });
            });
          if (NativePromise.any && typeof AggregateError !== "undefined")
            setProp(DexiePromise, "any", function() {
              var possiblePromises = getArrayOf.apply(null, arguments).map(onPossibleParallellAsync);
              return new DexiePromise(function(resolve, reject) {
                if (possiblePromises.length === 0)
                  reject(new AggregateError([]));
                var remaining = possiblePromises.length;
                var failures = new Array(remaining);
                possiblePromises.forEach(function(p3, i3) {
                  return DexiePromise.resolve(p3).then(function(value) {
                    return resolve(value);
                  }, function(failure) {
                    failures[i3] = failure;
                    if (!--remaining)
                      reject(new AggregateError(failures));
                  });
                });
              });
            });
          if (NativePromise.withResolvers)
            DexiePromise.withResolvers = NativePromise.withResolvers;
        }
        function executePromiseTask(promise, fn2) {
          try {
            fn2(function(value) {
              if (promise._state !== null)
                return;
              if (value === promise)
                throw new TypeError("A promise cannot be resolved with itself.");
              var shouldExecuteTick = promise._lib && beginMicroTickScope();
              if (value && typeof value.then === "function") {
                executePromiseTask(promise, function(resolve, reject) {
                  value instanceof DexiePromise ? value._then(resolve, reject) : value.then(resolve, reject);
                });
              } else {
                promise._state = true;
                promise._value = value;
                propagateAllListeners(promise);
              }
              if (shouldExecuteTick)
                endMicroTickScope();
            }, handleRejection.bind(null, promise));
          } catch (ex) {
            handleRejection(promise, ex);
          }
        }
        __name(executePromiseTask, "executePromiseTask");
        function handleRejection(promise, reason) {
          rejectingErrors.push(reason);
          if (promise._state !== null)
            return;
          var shouldExecuteTick = promise._lib && beginMicroTickScope();
          reason = rejectionMapper(reason);
          promise._state = false;
          promise._value = reason;
          addPossiblyUnhandledError(promise);
          propagateAllListeners(promise);
          if (shouldExecuteTick)
            endMicroTickScope();
        }
        __name(handleRejection, "handleRejection");
        function propagateAllListeners(promise) {
          var listeners = promise._listeners;
          promise._listeners = [];
          for (var i3 = 0, len = listeners.length; i3 < len; ++i3) {
            propagateToListener(promise, listeners[i3]);
          }
          var psd = promise._PSD;
          --psd.ref || psd.finalize();
          if (numScheduledCalls === 0) {
            ++numScheduledCalls;
            asap(function() {
              if (--numScheduledCalls === 0)
                finalizePhysicalTick();
            }, []);
          }
        }
        __name(propagateAllListeners, "propagateAllListeners");
        function propagateToListener(promise, listener) {
          if (promise._state === null) {
            promise._listeners.push(listener);
            return;
          }
          var cb = promise._state ? listener.onFulfilled : listener.onRejected;
          if (cb === null) {
            return (promise._state ? listener.resolve : listener.reject)(promise._value);
          }
          ++listener.psd.ref;
          ++numScheduledCalls;
          asap(callListener, [cb, promise, listener]);
        }
        __name(propagateToListener, "propagateToListener");
        function callListener(cb, promise, listener) {
          try {
            var ret, value = promise._value;
            if (!promise._state && rejectingErrors.length)
              rejectingErrors = [];
            ret = debug && promise._consoleTask ? promise._consoleTask.run(function() {
              return cb(value);
            }) : cb(value);
            if (!promise._state && rejectingErrors.indexOf(value) === -1) {
              markErrorAsHandled(promise);
            }
            listener.resolve(ret);
          } catch (e3) {
            listener.reject(e3);
          } finally {
            if (--numScheduledCalls === 0)
              finalizePhysicalTick();
            --listener.psd.ref || listener.psd.finalize();
          }
        }
        __name(callListener, "callListener");
        function physicalTick() {
          usePSD(globalPSD, function() {
            beginMicroTickScope() && endMicroTickScope();
          });
        }
        __name(physicalTick, "physicalTick");
        function beginMicroTickScope() {
          var wasRootExec = isOutsideMicroTick;
          isOutsideMicroTick = false;
          needsNewPhysicalTick = false;
          return wasRootExec;
        }
        __name(beginMicroTickScope, "beginMicroTickScope");
        function endMicroTickScope() {
          var callbacks, i3, l3;
          do {
            while (microtickQueue.length > 0) {
              callbacks = microtickQueue;
              microtickQueue = [];
              l3 = callbacks.length;
              for (i3 = 0; i3 < l3; ++i3) {
                var item = callbacks[i3];
                item[0].apply(null, item[1]);
              }
            }
          } while (microtickQueue.length > 0);
          isOutsideMicroTick = true;
          needsNewPhysicalTick = true;
        }
        __name(endMicroTickScope, "endMicroTickScope");
        function finalizePhysicalTick() {
          var unhandledErrs = unhandledErrors;
          unhandledErrors = [];
          unhandledErrs.forEach(function(p3) {
            p3._PSD.onunhandled.call(null, p3._value, p3);
          });
          var finalizers = tickFinalizers.slice(0);
          var i3 = finalizers.length;
          while (i3)
            finalizers[--i3]();
        }
        __name(finalizePhysicalTick, "finalizePhysicalTick");
        function run_at_end_of_this_or_next_physical_tick(fn2) {
          function finalizer() {
            fn2();
            tickFinalizers.splice(tickFinalizers.indexOf(finalizer), 1);
          }
          __name(finalizer, "finalizer");
          tickFinalizers.push(finalizer);
          ++numScheduledCalls;
          asap(function() {
            if (--numScheduledCalls === 0)
              finalizePhysicalTick();
          }, []);
        }
        __name(run_at_end_of_this_or_next_physical_tick, "run_at_end_of_this_or_next_physical_tick");
        function addPossiblyUnhandledError(promise) {
          if (!unhandledErrors.some(function(p3) {
            return p3._value === promise._value;
          }))
            unhandledErrors.push(promise);
        }
        __name(addPossiblyUnhandledError, "addPossiblyUnhandledError");
        function markErrorAsHandled(promise) {
          var i3 = unhandledErrors.length;
          while (i3)
            if (unhandledErrors[--i3]._value === promise._value) {
              unhandledErrors.splice(i3, 1);
              return;
            }
        }
        __name(markErrorAsHandled, "markErrorAsHandled");
        function PromiseReject(reason) {
          return new DexiePromise(INTERNAL, false, reason);
        }
        __name(PromiseReject, "PromiseReject");
        function wrap2(fn2, errorCatcher) {
          var psd = PSD;
          return function() {
            var wasRootExec = beginMicroTickScope(), outerScope = PSD;
            try {
              switchToZone(psd, true);
              return fn2.apply(this, arguments);
            } catch (e3) {
              errorCatcher && errorCatcher(e3);
            } finally {
              switchToZone(outerScope, false);
              if (wasRootExec)
                endMicroTickScope();
            }
          };
        }
        __name(wrap2, "wrap");
        var task = { awaits: 0, echoes: 0, id: 0 };
        var taskCounter = 0;
        var zoneStack = [];
        var zoneEchoes = 0;
        var totalEchoes = 0;
        var zone_id_counter = 0;
        function newScope(fn2, props2, a1, a22) {
          var parent = PSD, psd = Object.create(parent);
          psd.parent = parent;
          psd.ref = 0;
          psd.global = false;
          psd.id = ++zone_id_counter;
          globalPSD.env;
          psd.env = patchGlobalPromise ? {
            Promise: DexiePromise,
            PromiseProp: { value: DexiePromise, configurable: true, writable: true },
            all: DexiePromise.all,
            race: DexiePromise.race,
            allSettled: DexiePromise.allSettled,
            any: DexiePromise.any,
            resolve: DexiePromise.resolve,
            reject: DexiePromise.reject
          } : {};
          if (props2)
            extend(psd, props2);
          ++parent.ref;
          psd.finalize = function() {
            --this.parent.ref || this.parent.finalize();
          };
          var rv = usePSD(psd, fn2, a1, a22);
          if (psd.ref === 0)
            psd.finalize();
          return rv;
        }
        __name(newScope, "newScope");
        function incrementExpectedAwaits() {
          if (!task.id)
            task.id = ++taskCounter;
          ++task.awaits;
          task.echoes += ZONE_ECHO_LIMIT;
          return task.id;
        }
        __name(incrementExpectedAwaits, "incrementExpectedAwaits");
        function decrementExpectedAwaits() {
          if (!task.awaits)
            return false;
          if (--task.awaits === 0)
            task.id = 0;
          task.echoes = task.awaits * ZONE_ECHO_LIMIT;
          return true;
        }
        __name(decrementExpectedAwaits, "decrementExpectedAwaits");
        if (("" + nativePromiseThen).indexOf("[native code]") === -1) {
          incrementExpectedAwaits = decrementExpectedAwaits = nop;
        }
        function onPossibleParallellAsync(possiblePromise) {
          if (task.echoes && possiblePromise && possiblePromise.constructor === NativePromise) {
            incrementExpectedAwaits();
            return possiblePromise.then(function(x4) {
              decrementExpectedAwaits();
              return x4;
            }, function(e3) {
              decrementExpectedAwaits();
              return rejection(e3);
            });
          }
          return possiblePromise;
        }
        __name(onPossibleParallellAsync, "onPossibleParallellAsync");
        function zoneEnterEcho(targetZone) {
          ++totalEchoes;
          if (!task.echoes || --task.echoes === 0) {
            task.echoes = task.awaits = task.id = 0;
          }
          zoneStack.push(PSD);
          switchToZone(targetZone, true);
        }
        __name(zoneEnterEcho, "zoneEnterEcho");
        function zoneLeaveEcho() {
          var zone = zoneStack[zoneStack.length - 1];
          zoneStack.pop();
          switchToZone(zone, false);
        }
        __name(zoneLeaveEcho, "zoneLeaveEcho");
        function switchToZone(targetZone, bEnteringZone) {
          var currentZone = PSD;
          if (bEnteringZone ? task.echoes && (!zoneEchoes++ || targetZone !== PSD) : zoneEchoes && (!--zoneEchoes || targetZone !== PSD)) {
            queueMicrotask(bEnteringZone ? zoneEnterEcho.bind(null, targetZone) : zoneLeaveEcho);
          }
          if (targetZone === PSD)
            return;
          PSD = targetZone;
          if (currentZone === globalPSD)
            globalPSD.env = snapShot();
          if (patchGlobalPromise) {
            var GlobalPromise = globalPSD.env.Promise;
            var targetEnv = targetZone.env;
            if (currentZone.global || targetZone.global) {
              Object.defineProperty(_global, "Promise", targetEnv.PromiseProp);
              GlobalPromise.all = targetEnv.all;
              GlobalPromise.race = targetEnv.race;
              GlobalPromise.resolve = targetEnv.resolve;
              GlobalPromise.reject = targetEnv.reject;
              if (targetEnv.allSettled)
                GlobalPromise.allSettled = targetEnv.allSettled;
              if (targetEnv.any)
                GlobalPromise.any = targetEnv.any;
            }
          }
        }
        __name(switchToZone, "switchToZone");
        function snapShot() {
          var GlobalPromise = _global.Promise;
          return patchGlobalPromise ? {
            Promise: GlobalPromise,
            PromiseProp: Object.getOwnPropertyDescriptor(_global, "Promise"),
            all: GlobalPromise.all,
            race: GlobalPromise.race,
            allSettled: GlobalPromise.allSettled,
            any: GlobalPromise.any,
            resolve: GlobalPromise.resolve,
            reject: GlobalPromise.reject
          } : {};
        }
        __name(snapShot, "snapShot");
        function usePSD(psd, fn2, a1, a22, a3) {
          var outerScope = PSD;
          try {
            switchToZone(psd, true);
            return fn2(a1, a22, a3);
          } finally {
            switchToZone(outerScope, false);
          }
        }
        __name(usePSD, "usePSD");
        function nativeAwaitCompatibleWrap(fn2, zone, possibleAwait, cleanup) {
          return typeof fn2 !== "function" ? fn2 : function() {
            var outerZone = PSD;
            if (possibleAwait)
              incrementExpectedAwaits();
            switchToZone(zone, true);
            try {
              return fn2.apply(this, arguments);
            } finally {
              switchToZone(outerZone, false);
              if (cleanup)
                queueMicrotask(decrementExpectedAwaits);
            }
          };
        }
        __name(nativeAwaitCompatibleWrap, "nativeAwaitCompatibleWrap");
        function execInGlobalContext(cb) {
          if (Promise === NativePromise && task.echoes === 0) {
            if (zoneEchoes === 0) {
              cb();
            } else {
              enqueueNativeMicroTask(cb);
            }
          } else {
            setTimeout(cb, 0);
          }
        }
        __name(execInGlobalContext, "execInGlobalContext");
        var rejection = DexiePromise.reject;
        function tempTransaction(db, mode, storeNames, fn2) {
          if (!db.idbdb || !db._state.openComplete && (!PSD.letThrough && !db._vip)) {
            if (db._state.openComplete) {
              return rejection(new exceptions.DatabaseClosed(db._state.dbOpenError));
            }
            if (!db._state.isBeingOpened) {
              if (!db._state.autoOpen)
                return rejection(new exceptions.DatabaseClosed());
              db.open().catch(nop);
            }
            return db._state.dbReadyPromise.then(function() {
              return tempTransaction(db, mode, storeNames, fn2);
            });
          } else {
            var trans = db._createTransaction(mode, storeNames, db._dbSchema);
            try {
              trans.create();
              db._state.PR1398_maxLoop = 3;
            } catch (ex) {
              if (ex.name === errnames.InvalidState && db.isOpen() && --db._state.PR1398_maxLoop > 0) {
                console.warn("Dexie: Need to reopen db");
                db.close({ disableAutoOpen: false });
                return db.open().then(function() {
                  return tempTransaction(db, mode, storeNames, fn2);
                });
              }
              return rejection(ex);
            }
            return trans._promise(mode, function(resolve, reject) {
              return newScope(function() {
                PSD.trans = trans;
                return fn2(resolve, reject, trans);
              });
            }).then(function(result) {
              if (mode === "readwrite")
                try {
                  trans.idbtrans.commit();
                } catch (_a2) {
                }
              return mode === "readonly" ? result : trans._completion.then(function() {
                return result;
              });
            });
          }
        }
        __name(tempTransaction, "tempTransaction");
        var DEXIE_VERSION = "4.0.11";
        var maxString = String.fromCharCode(65535);
        var minKey = -Infinity;
        var INVALID_KEY_ARGUMENT = "Invalid key provided. Keys must be of type string, number, Date or Array<string | number | Date>.";
        var STRING_EXPECTED = "String expected.";
        var connections = [];
        var DBNAMES_DB = "__dbnames";
        var READONLY = "readonly";
        var READWRITE = "readwrite";
        function combine(filter1, filter2) {
          return filter1 ? filter2 ? function() {
            return filter1.apply(this, arguments) && filter2.apply(this, arguments);
          } : filter1 : filter2;
        }
        __name(combine, "combine");
        var AnyRange = {
          type: 3,
          lower: -Infinity,
          lowerOpen: false,
          upper: [[]],
          upperOpen: false
        };
        function workaroundForUndefinedPrimKey(keyPath) {
          return typeof keyPath === "string" && !/\./.test(keyPath) ? function(obj) {
            if (obj[keyPath] === void 0 && keyPath in obj) {
              obj = deepClone(obj);
              delete obj[keyPath];
            }
            return obj;
          } : function(obj) {
            return obj;
          };
        }
        __name(workaroundForUndefinedPrimKey, "workaroundForUndefinedPrimKey");
        function Entity2() {
          throw exceptions.Type();
        }
        __name(Entity2, "Entity");
        function cmp2(a3, b2) {
          try {
            var ta = type(a3);
            var tb = type(b2);
            if (ta !== tb) {
              if (ta === "Array")
                return 1;
              if (tb === "Array")
                return -1;
              if (ta === "binary")
                return 1;
              if (tb === "binary")
                return -1;
              if (ta === "string")
                return 1;
              if (tb === "string")
                return -1;
              if (ta === "Date")
                return 1;
              if (tb !== "Date")
                return NaN;
              return -1;
            }
            switch (ta) {
              case "number":
              case "Date":
              case "string":
                return a3 > b2 ? 1 : a3 < b2 ? -1 : 0;
              case "binary": {
                return compareUint8Arrays(getUint8Array(a3), getUint8Array(b2));
              }
              case "Array":
                return compareArrays(a3, b2);
            }
          } catch (_a2) {
          }
          return NaN;
        }
        __name(cmp2, "cmp");
        function compareArrays(a3, b2) {
          var al = a3.length;
          var bl = b2.length;
          var l3 = al < bl ? al : bl;
          for (var i3 = 0; i3 < l3; ++i3) {
            var res = cmp2(a3[i3], b2[i3]);
            if (res !== 0)
              return res;
          }
          return al === bl ? 0 : al < bl ? -1 : 1;
        }
        __name(compareArrays, "compareArrays");
        function compareUint8Arrays(a3, b2) {
          var al = a3.length;
          var bl = b2.length;
          var l3 = al < bl ? al : bl;
          for (var i3 = 0; i3 < l3; ++i3) {
            if (a3[i3] !== b2[i3])
              return a3[i3] < b2[i3] ? -1 : 1;
          }
          return al === bl ? 0 : al < bl ? -1 : 1;
        }
        __name(compareUint8Arrays, "compareUint8Arrays");
        function type(x4) {
          var t4 = typeof x4;
          if (t4 !== "object")
            return t4;
          if (ArrayBuffer.isView(x4))
            return "binary";
          var tsTag = toStringTag(x4);
          return tsTag === "ArrayBuffer" ? "binary" : tsTag;
        }
        __name(type, "type");
        function getUint8Array(a3) {
          if (a3 instanceof Uint8Array)
            return a3;
          if (ArrayBuffer.isView(a3))
            return new Uint8Array(a3.buffer, a3.byteOffset, a3.byteLength);
          return new Uint8Array(a3);
        }
        __name(getUint8Array, "getUint8Array");
        var Table = function() {
          function Table2() {
          }
          __name(Table2, "Table");
          Table2.prototype._trans = function(mode, fn2, writeLocked) {
            var trans = this._tx || PSD.trans;
            var tableName = this.name;
            var task2 = debug && typeof console !== "undefined" && console.createTask && console.createTask("Dexie: ".concat(mode === "readonly" ? "read" : "write", " ").concat(this.name));
            function checkTableInTransaction(resolve, reject, trans2) {
              if (!trans2.schema[tableName])
                throw new exceptions.NotFound("Table " + tableName + " not part of transaction");
              return fn2(trans2.idbtrans, trans2);
            }
            __name(checkTableInTransaction, "checkTableInTransaction");
            var wasRootExec = beginMicroTickScope();
            try {
              var p3 = trans && trans.db._novip === this.db._novip ? trans === PSD.trans ? trans._promise(mode, checkTableInTransaction, writeLocked) : newScope(function() {
                return trans._promise(mode, checkTableInTransaction, writeLocked);
              }, { trans, transless: PSD.transless || PSD }) : tempTransaction(this.db, mode, [this.name], checkTableInTransaction);
              if (task2) {
                p3._consoleTask = task2;
                p3 = p3.catch(function(err) {
                  console.trace(err);
                  return rejection(err);
                });
              }
              return p3;
            } finally {
              if (wasRootExec)
                endMicroTickScope();
            }
          };
          Table2.prototype.get = function(keyOrCrit, cb) {
            var _this = this;
            if (keyOrCrit && keyOrCrit.constructor === Object)
              return this.where(keyOrCrit).first(cb);
            if (keyOrCrit == null)
              return rejection(new exceptions.Type("Invalid argument to Table.get()"));
            return this._trans("readonly", function(trans) {
              return _this.core.get({ trans, key: keyOrCrit }).then(function(res) {
                return _this.hook.reading.fire(res);
              });
            }).then(cb);
          };
          Table2.prototype.where = function(indexOrCrit) {
            if (typeof indexOrCrit === "string")
              return new this.db.WhereClause(this, indexOrCrit);
            if (isArray(indexOrCrit))
              return new this.db.WhereClause(this, "[".concat(indexOrCrit.join("+"), "]"));
            var keyPaths = keys(indexOrCrit);
            if (keyPaths.length === 1)
              return this.where(keyPaths[0]).equals(indexOrCrit[keyPaths[0]]);
            var compoundIndex = this.schema.indexes.concat(this.schema.primKey).filter(function(ix) {
              if (ix.compound && keyPaths.every(function(keyPath) {
                return ix.keyPath.indexOf(keyPath) >= 0;
              })) {
                for (var i3 = 0; i3 < keyPaths.length; ++i3) {
                  if (keyPaths.indexOf(ix.keyPath[i3]) === -1)
                    return false;
                }
                return true;
              }
              return false;
            }).sort(function(a3, b2) {
              return a3.keyPath.length - b2.keyPath.length;
            })[0];
            if (compoundIndex && this.db._maxKey !== maxString) {
              var keyPathsInValidOrder = compoundIndex.keyPath.slice(0, keyPaths.length);
              return this.where(keyPathsInValidOrder).equals(keyPathsInValidOrder.map(function(kp) {
                return indexOrCrit[kp];
              }));
            }
            if (!compoundIndex && debug)
              console.warn("The query ".concat(JSON.stringify(indexOrCrit), " on ").concat(this.name, " would benefit from a ") + "compound index [".concat(keyPaths.join("+"), "]"));
            var idxByName = this.schema.idxByName;
            function equals(a3, b2) {
              return cmp2(a3, b2) === 0;
            }
            __name(equals, "equals");
            var _a2 = keyPaths.reduce(function(_a3, keyPath) {
              var prevIndex = _a3[0], prevFilterFn = _a3[1];
              var index = idxByName[keyPath];
              var value = indexOrCrit[keyPath];
              return [
                prevIndex || index,
                prevIndex || !index ? combine(prevFilterFn, index && index.multi ? function(x4) {
                  var prop = getByKeyPath(x4, keyPath);
                  return isArray(prop) && prop.some(function(item) {
                    return equals(value, item);
                  });
                } : function(x4) {
                  return equals(value, getByKeyPath(x4, keyPath));
                }) : prevFilterFn
              ];
            }, [null, null]), idx = _a2[0], filterFunction = _a2[1];
            return idx ? this.where(idx.name).equals(indexOrCrit[idx.keyPath]).filter(filterFunction) : compoundIndex ? this.filter(filterFunction) : this.where(keyPaths).equals("");
          };
          Table2.prototype.filter = function(filterFunction) {
            return this.toCollection().and(filterFunction);
          };
          Table2.prototype.count = function(thenShortcut) {
            return this.toCollection().count(thenShortcut);
          };
          Table2.prototype.offset = function(offset) {
            return this.toCollection().offset(offset);
          };
          Table2.prototype.limit = function(numRows) {
            return this.toCollection().limit(numRows);
          };
          Table2.prototype.each = function(callback) {
            return this.toCollection().each(callback);
          };
          Table2.prototype.toArray = function(thenShortcut) {
            return this.toCollection().toArray(thenShortcut);
          };
          Table2.prototype.toCollection = function() {
            return new this.db.Collection(new this.db.WhereClause(this));
          };
          Table2.prototype.orderBy = function(index) {
            return new this.db.Collection(new this.db.WhereClause(this, isArray(index) ? "[".concat(index.join("+"), "]") : index));
          };
          Table2.prototype.reverse = function() {
            return this.toCollection().reverse();
          };
          Table2.prototype.mapToClass = function(constructor) {
            var _a2 = this, db = _a2.db, tableName = _a2.name;
            this.schema.mappedClass = constructor;
            if (constructor.prototype instanceof Entity2) {
              constructor = function(_super) {
                __extends(class_1, _super);
                function class_1() {
                  return _super !== null && _super.apply(this, arguments) || this;
                }
                __name(class_1, "class_1");
                Object.defineProperty(class_1.prototype, "db", {
                  get: /* @__PURE__ */ __name(function() {
                    return db;
                  }, "get"),
                  enumerable: false,
                  configurable: true
                });
                class_1.prototype.table = function() {
                  return tableName;
                };
                return class_1;
              }(constructor);
            }
            var inheritedProps = /* @__PURE__ */ new Set();
            for (var proto = constructor.prototype; proto; proto = getProto(proto)) {
              Object.getOwnPropertyNames(proto).forEach(function(propName) {
                return inheritedProps.add(propName);
              });
            }
            var readHook = /* @__PURE__ */ __name(function(obj) {
              if (!obj)
                return obj;
              var res = Object.create(constructor.prototype);
              for (var m3 in obj)
                if (!inheritedProps.has(m3))
                  try {
                    res[m3] = obj[m3];
                  } catch (_3) {
                  }
              return res;
            }, "readHook");
            if (this.schema.readHook) {
              this.hook.reading.unsubscribe(this.schema.readHook);
            }
            this.schema.readHook = readHook;
            this.hook("reading", readHook);
            return constructor;
          };
          Table2.prototype.defineClass = function() {
            function Class(content) {
              extend(this, content);
            }
            __name(Class, "Class");
            return this.mapToClass(Class);
          };
          Table2.prototype.add = function(obj, key2) {
            var _this = this;
            var _a2 = this.schema.primKey, auto = _a2.auto, keyPath = _a2.keyPath;
            var objToAdd = obj;
            if (keyPath && auto) {
              objToAdd = workaroundForUndefinedPrimKey(keyPath)(obj);
            }
            return this._trans("readwrite", function(trans) {
              return _this.core.mutate({ trans, type: "add", keys: key2 != null ? [key2] : null, values: [objToAdd] });
            }).then(function(res) {
              return res.numFailures ? DexiePromise.reject(res.failures[0]) : res.lastResult;
            }).then(function(lastResult) {
              if (keyPath) {
                try {
                  setByKeyPath(obj, keyPath, lastResult);
                } catch (_3) {
                }
              }
              return lastResult;
            });
          };
          Table2.prototype.update = function(keyOrObject, modifications) {
            if (typeof keyOrObject === "object" && !isArray(keyOrObject)) {
              var key2 = getByKeyPath(keyOrObject, this.schema.primKey.keyPath);
              if (key2 === void 0)
                return rejection(new exceptions.InvalidArgument("Given object does not contain its primary key"));
              return this.where(":id").equals(key2).modify(modifications);
            } else {
              return this.where(":id").equals(keyOrObject).modify(modifications);
            }
          };
          Table2.prototype.put = function(obj, key2) {
            var _this = this;
            var _a2 = this.schema.primKey, auto = _a2.auto, keyPath = _a2.keyPath;
            var objToAdd = obj;
            if (keyPath && auto) {
              objToAdd = workaroundForUndefinedPrimKey(keyPath)(obj);
            }
            return this._trans("readwrite", function(trans) {
              return _this.core.mutate({ trans, type: "put", values: [objToAdd], keys: key2 != null ? [key2] : null });
            }).then(function(res) {
              return res.numFailures ? DexiePromise.reject(res.failures[0]) : res.lastResult;
            }).then(function(lastResult) {
              if (keyPath) {
                try {
                  setByKeyPath(obj, keyPath, lastResult);
                } catch (_3) {
                }
              }
              return lastResult;
            });
          };
          Table2.prototype.delete = function(key2) {
            var _this = this;
            return this._trans("readwrite", function(trans) {
              return _this.core.mutate({ trans, type: "delete", keys: [key2] });
            }).then(function(res) {
              return res.numFailures ? DexiePromise.reject(res.failures[0]) : void 0;
            });
          };
          Table2.prototype.clear = function() {
            var _this = this;
            return this._trans("readwrite", function(trans) {
              return _this.core.mutate({ trans, type: "deleteRange", range: AnyRange });
            }).then(function(res) {
              return res.numFailures ? DexiePromise.reject(res.failures[0]) : void 0;
            });
          };
          Table2.prototype.bulkGet = function(keys2) {
            var _this = this;
            return this._trans("readonly", function(trans) {
              return _this.core.getMany({
                keys: keys2,
                trans
              }).then(function(result) {
                return result.map(function(res) {
                  return _this.hook.reading.fire(res);
                });
              });
            });
          };
          Table2.prototype.bulkAdd = function(objects, keysOrOptions, options2) {
            var _this = this;
            var keys2 = Array.isArray(keysOrOptions) ? keysOrOptions : void 0;
            options2 = options2 || (keys2 ? void 0 : keysOrOptions);
            var wantResults = options2 ? options2.allKeys : void 0;
            return this._trans("readwrite", function(trans) {
              var _a2 = _this.schema.primKey, auto = _a2.auto, keyPath = _a2.keyPath;
              if (keyPath && keys2)
                throw new exceptions.InvalidArgument("bulkAdd(): keys argument invalid on tables with inbound keys");
              if (keys2 && keys2.length !== objects.length)
                throw new exceptions.InvalidArgument("Arguments objects and keys must have the same length");
              var numObjects = objects.length;
              var objectsToAdd = keyPath && auto ? objects.map(workaroundForUndefinedPrimKey(keyPath)) : objects;
              return _this.core.mutate({ trans, type: "add", keys: keys2, values: objectsToAdd, wantResults }).then(function(_a3) {
                var numFailures = _a3.numFailures, results = _a3.results, lastResult = _a3.lastResult, failures = _a3.failures;
                var result = wantResults ? results : lastResult;
                if (numFailures === 0)
                  return result;
                throw new BulkError("".concat(_this.name, ".bulkAdd(): ").concat(numFailures, " of ").concat(numObjects, " operations failed"), failures);
              });
            });
          };
          Table2.prototype.bulkPut = function(objects, keysOrOptions, options2) {
            var _this = this;
            var keys2 = Array.isArray(keysOrOptions) ? keysOrOptions : void 0;
            options2 = options2 || (keys2 ? void 0 : keysOrOptions);
            var wantResults = options2 ? options2.allKeys : void 0;
            return this._trans("readwrite", function(trans) {
              var _a2 = _this.schema.primKey, auto = _a2.auto, keyPath = _a2.keyPath;
              if (keyPath && keys2)
                throw new exceptions.InvalidArgument("bulkPut(): keys argument invalid on tables with inbound keys");
              if (keys2 && keys2.length !== objects.length)
                throw new exceptions.InvalidArgument("Arguments objects and keys must have the same length");
              var numObjects = objects.length;
              var objectsToPut = keyPath && auto ? objects.map(workaroundForUndefinedPrimKey(keyPath)) : objects;
              return _this.core.mutate({ trans, type: "put", keys: keys2, values: objectsToPut, wantResults }).then(function(_a3) {
                var numFailures = _a3.numFailures, results = _a3.results, lastResult = _a3.lastResult, failures = _a3.failures;
                var result = wantResults ? results : lastResult;
                if (numFailures === 0)
                  return result;
                throw new BulkError("".concat(_this.name, ".bulkPut(): ").concat(numFailures, " of ").concat(numObjects, " operations failed"), failures);
              });
            });
          };
          Table2.prototype.bulkUpdate = function(keysAndChanges) {
            var _this = this;
            var coreTable = this.core;
            var keys2 = keysAndChanges.map(function(entry) {
              return entry.key;
            });
            var changeSpecs = keysAndChanges.map(function(entry) {
              return entry.changes;
            });
            var offsetMap = [];
            return this._trans("readwrite", function(trans) {
              return coreTable.getMany({ trans, keys: keys2, cache: "clone" }).then(function(objs) {
                var resultKeys = [];
                var resultObjs = [];
                keysAndChanges.forEach(function(_a2, idx) {
                  var key2 = _a2.key, changes = _a2.changes;
                  var obj = objs[idx];
                  if (obj) {
                    for (var _i = 0, _b = Object.keys(changes); _i < _b.length; _i++) {
                      var keyPath = _b[_i];
                      var value = changes[keyPath];
                      if (keyPath === _this.schema.primKey.keyPath) {
                        if (cmp2(value, key2) !== 0) {
                          throw new exceptions.Constraint("Cannot update primary key in bulkUpdate()");
                        }
                      } else {
                        setByKeyPath(obj, keyPath, value);
                      }
                    }
                    offsetMap.push(idx);
                    resultKeys.push(key2);
                    resultObjs.push(obj);
                  }
                });
                var numEntries = resultKeys.length;
                return coreTable.mutate({
                  trans,
                  type: "put",
                  keys: resultKeys,
                  values: resultObjs,
                  updates: {
                    keys: keys2,
                    changeSpecs
                  }
                }).then(function(_a2) {
                  var numFailures = _a2.numFailures, failures = _a2.failures;
                  if (numFailures === 0)
                    return numEntries;
                  for (var _i = 0, _b = Object.keys(failures); _i < _b.length; _i++) {
                    var offset = _b[_i];
                    var mappedOffset = offsetMap[Number(offset)];
                    if (mappedOffset != null) {
                      var failure = failures[offset];
                      delete failures[offset];
                      failures[mappedOffset] = failure;
                    }
                  }
                  throw new BulkError("".concat(_this.name, ".bulkUpdate(): ").concat(numFailures, " of ").concat(numEntries, " operations failed"), failures);
                });
              });
            });
          };
          Table2.prototype.bulkDelete = function(keys2) {
            var _this = this;
            var numKeys = keys2.length;
            return this._trans("readwrite", function(trans) {
              return _this.core.mutate({ trans, type: "delete", keys: keys2 });
            }).then(function(_a2) {
              var numFailures = _a2.numFailures, lastResult = _a2.lastResult, failures = _a2.failures;
              if (numFailures === 0)
                return lastResult;
              throw new BulkError("".concat(_this.name, ".bulkDelete(): ").concat(numFailures, " of ").concat(numKeys, " operations failed"), failures);
            });
          };
          return Table2;
        }();
        function Events(ctx) {
          var evs = {};
          var rv = /* @__PURE__ */ __name(function(eventName, subscriber) {
            if (subscriber) {
              var i4 = arguments.length, args = new Array(i4 - 1);
              while (--i4)
                args[i4 - 1] = arguments[i4];
              evs[eventName].subscribe.apply(null, args);
              return ctx;
            } else if (typeof eventName === "string") {
              return evs[eventName];
            }
          }, "rv");
          rv.addEventType = add3;
          for (var i3 = 1, l3 = arguments.length; i3 < l3; ++i3) {
            add3(arguments[i3]);
          }
          return rv;
          function add3(eventName, chainFunction, defaultFunction) {
            if (typeof eventName === "object")
              return addConfiguredEvents(eventName);
            if (!chainFunction)
              chainFunction = reverseStoppableEventChain;
            if (!defaultFunction)
              defaultFunction = nop;
            var context = {
              subscribers: [],
              fire: defaultFunction,
              subscribe: /* @__PURE__ */ __name(function(cb) {
                if (context.subscribers.indexOf(cb) === -1) {
                  context.subscribers.push(cb);
                  context.fire = chainFunction(context.fire, cb);
                }
              }, "subscribe"),
              unsubscribe: /* @__PURE__ */ __name(function(cb) {
                context.subscribers = context.subscribers.filter(function(fn2) {
                  return fn2 !== cb;
                });
                context.fire = context.subscribers.reduce(chainFunction, defaultFunction);
              }, "unsubscribe")
            };
            evs[eventName] = rv[eventName] = context;
            return context;
          }
          __name(add3, "add");
          function addConfiguredEvents(cfg) {
            keys(cfg).forEach(function(eventName) {
              var args = cfg[eventName];
              if (isArray(args)) {
                add3(eventName, cfg[eventName][0], cfg[eventName][1]);
              } else if (args === "asap") {
                var context = add3(eventName, mirror, /* @__PURE__ */ __name(function fire() {
                  var i4 = arguments.length, args2 = new Array(i4);
                  while (i4--)
                    args2[i4] = arguments[i4];
                  context.subscribers.forEach(function(fn2) {
                    asap$1(/* @__PURE__ */ __name(function fireEvent() {
                      fn2.apply(null, args2);
                    }, "fireEvent"));
                  });
                }, "fire"));
              } else
                throw new exceptions.InvalidArgument("Invalid event config");
            });
          }
          __name(addConfiguredEvents, "addConfiguredEvents");
        }
        __name(Events, "Events");
        function makeClassConstructor(prototype, constructor) {
          derive(constructor).from({ prototype });
          return constructor;
        }
        __name(makeClassConstructor, "makeClassConstructor");
        function createTableConstructor(db) {
          return makeClassConstructor(Table.prototype, /* @__PURE__ */ __name(function Table2(name, tableSchema, trans) {
            this.db = db;
            this._tx = trans;
            this.name = name;
            this.schema = tableSchema;
            this.hook = db._allTables[name] ? db._allTables[name].hook : Events(null, {
              "creating": [hookCreatingChain, nop],
              "reading": [pureFunctionChain, mirror],
              "updating": [hookUpdatingChain, nop],
              "deleting": [hookDeletingChain, nop]
            });
          }, "Table"));
        }
        __name(createTableConstructor, "createTableConstructor");
        function isPlainKeyRange(ctx, ignoreLimitFilter) {
          return !(ctx.filter || ctx.algorithm || ctx.or) && (ignoreLimitFilter ? ctx.justLimit : !ctx.replayFilter);
        }
        __name(isPlainKeyRange, "isPlainKeyRange");
        function addFilter(ctx, fn2) {
          ctx.filter = combine(ctx.filter, fn2);
        }
        __name(addFilter, "addFilter");
        function addReplayFilter(ctx, factory, isLimitFilter) {
          var curr = ctx.replayFilter;
          ctx.replayFilter = curr ? function() {
            return combine(curr(), factory());
          } : factory;
          ctx.justLimit = isLimitFilter && !curr;
        }
        __name(addReplayFilter, "addReplayFilter");
        function addMatchFilter(ctx, fn2) {
          ctx.isMatch = combine(ctx.isMatch, fn2);
        }
        __name(addMatchFilter, "addMatchFilter");
        function getIndexOrStore(ctx, coreSchema) {
          if (ctx.isPrimKey)
            return coreSchema.primaryKey;
          var index = coreSchema.getIndexByKeyPath(ctx.index);
          if (!index)
            throw new exceptions.Schema("KeyPath " + ctx.index + " on object store " + coreSchema.name + " is not indexed");
          return index;
        }
        __name(getIndexOrStore, "getIndexOrStore");
        function openCursor(ctx, coreTable, trans) {
          var index = getIndexOrStore(ctx, coreTable.schema);
          return coreTable.openCursor({
            trans,
            values: !ctx.keysOnly,
            reverse: ctx.dir === "prev",
            unique: !!ctx.unique,
            query: {
              index,
              range: ctx.range
            }
          });
        }
        __name(openCursor, "openCursor");
        function iter(ctx, fn2, coreTrans, coreTable) {
          var filter = ctx.replayFilter ? combine(ctx.filter, ctx.replayFilter()) : ctx.filter;
          if (!ctx.or) {
            return iterate(openCursor(ctx, coreTable, coreTrans), combine(ctx.algorithm, filter), fn2, !ctx.keysOnly && ctx.valueMapper);
          } else {
            var set_1 = {};
            var union = /* @__PURE__ */ __name(function(item, cursor, advance) {
              if (!filter || filter(cursor, advance, function(result) {
                return cursor.stop(result);
              }, function(err) {
                return cursor.fail(err);
              })) {
                var primaryKey = cursor.primaryKey;
                var key2 = "" + primaryKey;
                if (key2 === "[object ArrayBuffer]")
                  key2 = "" + new Uint8Array(primaryKey);
                if (!hasOwn(set_1, key2)) {
                  set_1[key2] = true;
                  fn2(item, cursor, advance);
                }
              }
            }, "union");
            return Promise.all([
              ctx.or._iterate(union, coreTrans),
              iterate(openCursor(ctx, coreTable, coreTrans), ctx.algorithm, union, !ctx.keysOnly && ctx.valueMapper)
            ]);
          }
        }
        __name(iter, "iter");
        function iterate(cursorPromise, filter, fn2, valueMapper) {
          var mappedFn = valueMapper ? function(x4, c3, a3) {
            return fn2(valueMapper(x4), c3, a3);
          } : fn2;
          var wrappedFn = wrap2(mappedFn);
          return cursorPromise.then(function(cursor) {
            if (cursor) {
              return cursor.start(function() {
                var c3 = /* @__PURE__ */ __name(function() {
                  return cursor.continue();
                }, "c");
                if (!filter || filter(cursor, function(advancer) {
                  return c3 = advancer;
                }, function(val) {
                  cursor.stop(val);
                  c3 = nop;
                }, function(e3) {
                  cursor.fail(e3);
                  c3 = nop;
                }))
                  wrappedFn(cursor.value, cursor, function(advancer) {
                    return c3 = advancer;
                  });
                c3();
              });
            }
          });
        }
        __name(iterate, "iterate");
        var PropModification2 = function() {
          function PropModification3(spec) {
            this["@@propmod"] = spec;
          }
          __name(PropModification3, "PropModification");
          PropModification3.prototype.execute = function(value) {
            var _a2;
            var spec = this["@@propmod"];
            if (spec.add !== void 0) {
              var term = spec.add;
              if (isArray(term)) {
                return __spreadArray(__spreadArray([], isArray(value) ? value : [], true), term, true).sort();
              }
              if (typeof term === "number")
                return (Number(value) || 0) + term;
              if (typeof term === "bigint") {
                try {
                  return BigInt(value) + term;
                } catch (_b) {
                  return BigInt(0) + term;
                }
              }
              throw new TypeError("Invalid term ".concat(term));
            }
            if (spec.remove !== void 0) {
              var subtrahend_1 = spec.remove;
              if (isArray(subtrahend_1)) {
                return isArray(value) ? value.filter(function(item) {
                  return !subtrahend_1.includes(item);
                }).sort() : [];
              }
              if (typeof subtrahend_1 === "number")
                return Number(value) - subtrahend_1;
              if (typeof subtrahend_1 === "bigint") {
                try {
                  return BigInt(value) - subtrahend_1;
                } catch (_c) {
                  return BigInt(0) - subtrahend_1;
                }
              }
              throw new TypeError("Invalid subtrahend ".concat(subtrahend_1));
            }
            var prefixToReplace = (_a2 = spec.replacePrefix) === null || _a2 === void 0 ? void 0 : _a2[0];
            if (prefixToReplace && typeof value === "string" && value.startsWith(prefixToReplace)) {
              return spec.replacePrefix[1] + value.substring(prefixToReplace.length);
            }
            return value;
          };
          return PropModification3;
        }();
        var Collection = function() {
          function Collection2() {
          }
          __name(Collection2, "Collection");
          Collection2.prototype._read = function(fn2, cb) {
            var ctx = this._ctx;
            return ctx.error ? ctx.table._trans(null, rejection.bind(null, ctx.error)) : ctx.table._trans("readonly", fn2).then(cb);
          };
          Collection2.prototype._write = function(fn2) {
            var ctx = this._ctx;
            return ctx.error ? ctx.table._trans(null, rejection.bind(null, ctx.error)) : ctx.table._trans("readwrite", fn2, "locked");
          };
          Collection2.prototype._addAlgorithm = function(fn2) {
            var ctx = this._ctx;
            ctx.algorithm = combine(ctx.algorithm, fn2);
          };
          Collection2.prototype._iterate = function(fn2, coreTrans) {
            return iter(this._ctx, fn2, coreTrans, this._ctx.table.core);
          };
          Collection2.prototype.clone = function(props2) {
            var rv = Object.create(this.constructor.prototype), ctx = Object.create(this._ctx);
            if (props2)
              extend(ctx, props2);
            rv._ctx = ctx;
            return rv;
          };
          Collection2.prototype.raw = function() {
            this._ctx.valueMapper = null;
            return this;
          };
          Collection2.prototype.each = function(fn2) {
            var ctx = this._ctx;
            return this._read(function(trans) {
              return iter(ctx, fn2, trans, ctx.table.core);
            });
          };
          Collection2.prototype.count = function(cb) {
            var _this = this;
            return this._read(function(trans) {
              var ctx = _this._ctx;
              var coreTable = ctx.table.core;
              if (isPlainKeyRange(ctx, true)) {
                return coreTable.count({
                  trans,
                  query: {
                    index: getIndexOrStore(ctx, coreTable.schema),
                    range: ctx.range
                  }
                }).then(function(count2) {
                  return Math.min(count2, ctx.limit);
                });
              } else {
                var count = 0;
                return iter(ctx, function() {
                  ++count;
                  return false;
                }, trans, coreTable).then(function() {
                  return count;
                });
              }
            }).then(cb);
          };
          Collection2.prototype.sortBy = function(keyPath, cb) {
            var parts = keyPath.split(".").reverse(), lastPart = parts[0], lastIndex = parts.length - 1;
            function getval(obj, i3) {
              if (i3)
                return getval(obj[parts[i3]], i3 - 1);
              return obj[lastPart];
            }
            __name(getval, "getval");
            var order = this._ctx.dir === "next" ? 1 : -1;
            function sorter(a3, b2) {
              var aVal = getval(a3, lastIndex), bVal = getval(b2, lastIndex);
              return cmp2(aVal, bVal) * order;
            }
            __name(sorter, "sorter");
            return this.toArray(function(a3) {
              return a3.sort(sorter);
            }).then(cb);
          };
          Collection2.prototype.toArray = function(cb) {
            var _this = this;
            return this._read(function(trans) {
              var ctx = _this._ctx;
              if (ctx.dir === "next" && isPlainKeyRange(ctx, true) && ctx.limit > 0) {
                var valueMapper_1 = ctx.valueMapper;
                var index = getIndexOrStore(ctx, ctx.table.core.schema);
                return ctx.table.core.query({
                  trans,
                  limit: ctx.limit,
                  values: true,
                  query: {
                    index,
                    range: ctx.range
                  }
                }).then(function(_a2) {
                  var result = _a2.result;
                  return valueMapper_1 ? result.map(valueMapper_1) : result;
                });
              } else {
                var a_1 = [];
                return iter(ctx, function(item) {
                  return a_1.push(item);
                }, trans, ctx.table.core).then(function() {
                  return a_1;
                });
              }
            }, cb);
          };
          Collection2.prototype.offset = function(offset) {
            var ctx = this._ctx;
            if (offset <= 0)
              return this;
            ctx.offset += offset;
            if (isPlainKeyRange(ctx)) {
              addReplayFilter(ctx, function() {
                var offsetLeft = offset;
                return function(cursor, advance) {
                  if (offsetLeft === 0)
                    return true;
                  if (offsetLeft === 1) {
                    --offsetLeft;
                    return false;
                  }
                  advance(function() {
                    cursor.advance(offsetLeft);
                    offsetLeft = 0;
                  });
                  return false;
                };
              });
            } else {
              addReplayFilter(ctx, function() {
                var offsetLeft = offset;
                return function() {
                  return --offsetLeft < 0;
                };
              });
            }
            return this;
          };
          Collection2.prototype.limit = function(numRows) {
            this._ctx.limit = Math.min(this._ctx.limit, numRows);
            addReplayFilter(this._ctx, function() {
              var rowsLeft = numRows;
              return function(cursor, advance, resolve) {
                if (--rowsLeft <= 0)
                  advance(resolve);
                return rowsLeft >= 0;
              };
            }, true);
            return this;
          };
          Collection2.prototype.until = function(filterFunction, bIncludeStopEntry) {
            addFilter(this._ctx, function(cursor, advance, resolve) {
              if (filterFunction(cursor.value)) {
                advance(resolve);
                return bIncludeStopEntry;
              } else {
                return true;
              }
            });
            return this;
          };
          Collection2.prototype.first = function(cb) {
            return this.limit(1).toArray(function(a3) {
              return a3[0];
            }).then(cb);
          };
          Collection2.prototype.last = function(cb) {
            return this.reverse().first(cb);
          };
          Collection2.prototype.filter = function(filterFunction) {
            addFilter(this._ctx, function(cursor) {
              return filterFunction(cursor.value);
            });
            addMatchFilter(this._ctx, filterFunction);
            return this;
          };
          Collection2.prototype.and = function(filter) {
            return this.filter(filter);
          };
          Collection2.prototype.or = function(indexName) {
            return new this.db.WhereClause(this._ctx.table, indexName, this);
          };
          Collection2.prototype.reverse = function() {
            this._ctx.dir = this._ctx.dir === "prev" ? "next" : "prev";
            if (this._ondirectionchange)
              this._ondirectionchange(this._ctx.dir);
            return this;
          };
          Collection2.prototype.desc = function() {
            return this.reverse();
          };
          Collection2.prototype.eachKey = function(cb) {
            var ctx = this._ctx;
            ctx.keysOnly = !ctx.isMatch;
            return this.each(function(val, cursor) {
              cb(cursor.key, cursor);
            });
          };
          Collection2.prototype.eachUniqueKey = function(cb) {
            this._ctx.unique = "unique";
            return this.eachKey(cb);
          };
          Collection2.prototype.eachPrimaryKey = function(cb) {
            var ctx = this._ctx;
            ctx.keysOnly = !ctx.isMatch;
            return this.each(function(val, cursor) {
              cb(cursor.primaryKey, cursor);
            });
          };
          Collection2.prototype.keys = function(cb) {
            var ctx = this._ctx;
            ctx.keysOnly = !ctx.isMatch;
            var a3 = [];
            return this.each(function(item, cursor) {
              a3.push(cursor.key);
            }).then(function() {
              return a3;
            }).then(cb);
          };
          Collection2.prototype.primaryKeys = function(cb) {
            var ctx = this._ctx;
            if (ctx.dir === "next" && isPlainKeyRange(ctx, true) && ctx.limit > 0) {
              return this._read(function(trans) {
                var index = getIndexOrStore(ctx, ctx.table.core.schema);
                return ctx.table.core.query({
                  trans,
                  values: false,
                  limit: ctx.limit,
                  query: {
                    index,
                    range: ctx.range
                  }
                });
              }).then(function(_a2) {
                var result = _a2.result;
                return result;
              }).then(cb);
            }
            ctx.keysOnly = !ctx.isMatch;
            var a3 = [];
            return this.each(function(item, cursor) {
              a3.push(cursor.primaryKey);
            }).then(function() {
              return a3;
            }).then(cb);
          };
          Collection2.prototype.uniqueKeys = function(cb) {
            this._ctx.unique = "unique";
            return this.keys(cb);
          };
          Collection2.prototype.firstKey = function(cb) {
            return this.limit(1).keys(function(a3) {
              return a3[0];
            }).then(cb);
          };
          Collection2.prototype.lastKey = function(cb) {
            return this.reverse().firstKey(cb);
          };
          Collection2.prototype.distinct = function() {
            var ctx = this._ctx, idx = ctx.index && ctx.table.schema.idxByName[ctx.index];
            if (!idx || !idx.multi)
              return this;
            var set = {};
            addFilter(this._ctx, function(cursor) {
              var strKey = cursor.primaryKey.toString();
              var found = hasOwn(set, strKey);
              set[strKey] = true;
              return !found;
            });
            return this;
          };
          Collection2.prototype.modify = function(changes) {
            var _this = this;
            var ctx = this._ctx;
            return this._write(function(trans) {
              var modifyer;
              if (typeof changes === "function") {
                modifyer = changes;
              } else {
                var keyPaths = keys(changes);
                var numKeys = keyPaths.length;
                modifyer = /* @__PURE__ */ __name(function(item) {
                  var anythingModified = false;
                  for (var i3 = 0; i3 < numKeys; ++i3) {
                    var keyPath = keyPaths[i3];
                    var val = changes[keyPath];
                    var origVal = getByKeyPath(item, keyPath);
                    if (val instanceof PropModification2) {
                      setByKeyPath(item, keyPath, val.execute(origVal));
                      anythingModified = true;
                    } else if (origVal !== val) {
                      setByKeyPath(item, keyPath, val);
                      anythingModified = true;
                    }
                  }
                  return anythingModified;
                }, "modifyer");
              }
              var coreTable = ctx.table.core;
              var _a2 = coreTable.schema.primaryKey, outbound = _a2.outbound, extractKey = _a2.extractKey;
              var limit = 200;
              var modifyChunkSize = _this.db._options.modifyChunkSize;
              if (modifyChunkSize) {
                if (typeof modifyChunkSize == "object") {
                  limit = modifyChunkSize[coreTable.name] || modifyChunkSize["*"] || 200;
                } else {
                  limit = modifyChunkSize;
                }
              }
              var totalFailures = [];
              var successCount = 0;
              var failedKeys = [];
              var applyMutateResult = /* @__PURE__ */ __name(function(expectedCount, res) {
                var failures = res.failures, numFailures = res.numFailures;
                successCount += expectedCount - numFailures;
                for (var _i = 0, _a3 = keys(failures); _i < _a3.length; _i++) {
                  var pos = _a3[_i];
                  totalFailures.push(failures[pos]);
                }
              }, "applyMutateResult");
              return _this.clone().primaryKeys().then(function(keys2) {
                var criteria = isPlainKeyRange(ctx) && ctx.limit === Infinity && (typeof changes !== "function" || changes === deleteCallback) && {
                  index: ctx.index,
                  range: ctx.range
                };
                var nextChunk = /* @__PURE__ */ __name(function(offset) {
                  var count = Math.min(limit, keys2.length - offset);
                  return coreTable.getMany({
                    trans,
                    keys: keys2.slice(offset, offset + count),
                    cache: "immutable"
                  }).then(function(values) {
                    var addValues = [];
                    var putValues = [];
                    var putKeys = outbound ? [] : null;
                    var deleteKeys = [];
                    for (var i3 = 0; i3 < count; ++i3) {
                      var origValue = values[i3];
                      var ctx_1 = {
                        value: deepClone(origValue),
                        primKey: keys2[offset + i3]
                      };
                      if (modifyer.call(ctx_1, ctx_1.value, ctx_1) !== false) {
                        if (ctx_1.value == null) {
                          deleteKeys.push(keys2[offset + i3]);
                        } else if (!outbound && cmp2(extractKey(origValue), extractKey(ctx_1.value)) !== 0) {
                          deleteKeys.push(keys2[offset + i3]);
                          addValues.push(ctx_1.value);
                        } else {
                          putValues.push(ctx_1.value);
                          if (outbound)
                            putKeys.push(keys2[offset + i3]);
                        }
                      }
                    }
                    return Promise.resolve(addValues.length > 0 && coreTable.mutate({ trans, type: "add", values: addValues }).then(function(res) {
                      for (var pos in res.failures) {
                        deleteKeys.splice(parseInt(pos), 1);
                      }
                      applyMutateResult(addValues.length, res);
                    })).then(function() {
                      return (putValues.length > 0 || criteria && typeof changes === "object") && coreTable.mutate({
                        trans,
                        type: "put",
                        keys: putKeys,
                        values: putValues,
                        criteria,
                        changeSpec: typeof changes !== "function" && changes,
                        isAdditionalChunk: offset > 0
                      }).then(function(res) {
                        return applyMutateResult(putValues.length, res);
                      });
                    }).then(function() {
                      return (deleteKeys.length > 0 || criteria && changes === deleteCallback) && coreTable.mutate({
                        trans,
                        type: "delete",
                        keys: deleteKeys,
                        criteria,
                        isAdditionalChunk: offset > 0
                      }).then(function(res) {
                        return applyMutateResult(deleteKeys.length, res);
                      });
                    }).then(function() {
                      return keys2.length > offset + count && nextChunk(offset + limit);
                    });
                  });
                }, "nextChunk");
                return nextChunk(0).then(function() {
                  if (totalFailures.length > 0)
                    throw new ModifyError("Error modifying one or more objects", totalFailures, successCount, failedKeys);
                  return keys2.length;
                });
              });
            });
          };
          Collection2.prototype.delete = function() {
            var ctx = this._ctx, range = ctx.range;
            if (isPlainKeyRange(ctx) && (ctx.isPrimKey || range.type === 3)) {
              return this._write(function(trans) {
                var primaryKey = ctx.table.core.schema.primaryKey;
                var coreRange = range;
                return ctx.table.core.count({ trans, query: { index: primaryKey, range: coreRange } }).then(function(count) {
                  return ctx.table.core.mutate({ trans, type: "deleteRange", range: coreRange }).then(function(_a2) {
                    var failures = _a2.failures;
                    _a2.lastResult;
                    _a2.results;
                    var numFailures = _a2.numFailures;
                    if (numFailures)
                      throw new ModifyError("Could not delete some values", Object.keys(failures).map(function(pos) {
                        return failures[pos];
                      }), count - numFailures);
                    return count - numFailures;
                  });
                });
              });
            }
            return this.modify(deleteCallback);
          };
          return Collection2;
        }();
        var deleteCallback = /* @__PURE__ */ __name(function(value, ctx) {
          return ctx.value = null;
        }, "deleteCallback");
        function createCollectionConstructor(db) {
          return makeClassConstructor(Collection.prototype, /* @__PURE__ */ __name(function Collection2(whereClause, keyRangeGenerator) {
            this.db = db;
            var keyRange = AnyRange, error = null;
            if (keyRangeGenerator)
              try {
                keyRange = keyRangeGenerator();
              } catch (ex) {
                error = ex;
              }
            var whereCtx = whereClause._ctx;
            var table = whereCtx.table;
            var readingHook = table.hook.reading.fire;
            this._ctx = {
              table,
              index: whereCtx.index,
              isPrimKey: !whereCtx.index || table.schema.primKey.keyPath && whereCtx.index === table.schema.primKey.name,
              range: keyRange,
              keysOnly: false,
              dir: "next",
              unique: "",
              algorithm: null,
              filter: null,
              replayFilter: null,
              justLimit: true,
              isMatch: null,
              offset: 0,
              limit: Infinity,
              error,
              or: whereCtx.or,
              valueMapper: readingHook !== mirror ? readingHook : null
            };
          }, "Collection"));
        }
        __name(createCollectionConstructor, "createCollectionConstructor");
        function simpleCompare(a3, b2) {
          return a3 < b2 ? -1 : a3 === b2 ? 0 : 1;
        }
        __name(simpleCompare, "simpleCompare");
        function simpleCompareReverse(a3, b2) {
          return a3 > b2 ? -1 : a3 === b2 ? 0 : 1;
        }
        __name(simpleCompareReverse, "simpleCompareReverse");
        function fail(collectionOrWhereClause, err, T4) {
          var collection = collectionOrWhereClause instanceof WhereClause ? new collectionOrWhereClause.Collection(collectionOrWhereClause) : collectionOrWhereClause;
          collection._ctx.error = T4 ? new T4(err) : new TypeError(err);
          return collection;
        }
        __name(fail, "fail");
        function emptyCollection(whereClause) {
          return new whereClause.Collection(whereClause, function() {
            return rangeEqual("");
          }).limit(0);
        }
        __name(emptyCollection, "emptyCollection");
        function upperFactory(dir) {
          return dir === "next" ? function(s3) {
            return s3.toUpperCase();
          } : function(s3) {
            return s3.toLowerCase();
          };
        }
        __name(upperFactory, "upperFactory");
        function lowerFactory(dir) {
          return dir === "next" ? function(s3) {
            return s3.toLowerCase();
          } : function(s3) {
            return s3.toUpperCase();
          };
        }
        __name(lowerFactory, "lowerFactory");
        function nextCasing(key2, lowerKey, upperNeedle, lowerNeedle, cmp3, dir) {
          var length = Math.min(key2.length, lowerNeedle.length);
          var llp = -1;
          for (var i3 = 0; i3 < length; ++i3) {
            var lwrKeyChar = lowerKey[i3];
            if (lwrKeyChar !== lowerNeedle[i3]) {
              if (cmp3(key2[i3], upperNeedle[i3]) < 0)
                return key2.substr(0, i3) + upperNeedle[i3] + upperNeedle.substr(i3 + 1);
              if (cmp3(key2[i3], lowerNeedle[i3]) < 0)
                return key2.substr(0, i3) + lowerNeedle[i3] + upperNeedle.substr(i3 + 1);
              if (llp >= 0)
                return key2.substr(0, llp) + lowerKey[llp] + upperNeedle.substr(llp + 1);
              return null;
            }
            if (cmp3(key2[i3], lwrKeyChar) < 0)
              llp = i3;
          }
          if (length < lowerNeedle.length && dir === "next")
            return key2 + upperNeedle.substr(key2.length);
          if (length < key2.length && dir === "prev")
            return key2.substr(0, upperNeedle.length);
          return llp < 0 ? null : key2.substr(0, llp) + lowerNeedle[llp] + upperNeedle.substr(llp + 1);
        }
        __name(nextCasing, "nextCasing");
        function addIgnoreCaseAlgorithm(whereClause, match, needles, suffix) {
          var upper, lower, compare, upperNeedles, lowerNeedles, direction, nextKeySuffix, needlesLen = needles.length;
          if (!needles.every(function(s3) {
            return typeof s3 === "string";
          })) {
            return fail(whereClause, STRING_EXPECTED);
          }
          function initDirection(dir) {
            upper = upperFactory(dir);
            lower = lowerFactory(dir);
            compare = dir === "next" ? simpleCompare : simpleCompareReverse;
            var needleBounds = needles.map(function(needle) {
              return { lower: lower(needle), upper: upper(needle) };
            }).sort(function(a3, b2) {
              return compare(a3.lower, b2.lower);
            });
            upperNeedles = needleBounds.map(function(nb) {
              return nb.upper;
            });
            lowerNeedles = needleBounds.map(function(nb) {
              return nb.lower;
            });
            direction = dir;
            nextKeySuffix = dir === "next" ? "" : suffix;
          }
          __name(initDirection, "initDirection");
          initDirection("next");
          var c3 = new whereClause.Collection(whereClause, function() {
            return createRange(upperNeedles[0], lowerNeedles[needlesLen - 1] + suffix);
          });
          c3._ondirectionchange = function(direction2) {
            initDirection(direction2);
          };
          var firstPossibleNeedle = 0;
          c3._addAlgorithm(function(cursor, advance, resolve) {
            var key2 = cursor.key;
            if (typeof key2 !== "string")
              return false;
            var lowerKey = lower(key2);
            if (match(lowerKey, lowerNeedles, firstPossibleNeedle)) {
              return true;
            } else {
              var lowestPossibleCasing = null;
              for (var i3 = firstPossibleNeedle; i3 < needlesLen; ++i3) {
                var casing = nextCasing(key2, lowerKey, upperNeedles[i3], lowerNeedles[i3], compare, direction);
                if (casing === null && lowestPossibleCasing === null)
                  firstPossibleNeedle = i3 + 1;
                else if (lowestPossibleCasing === null || compare(lowestPossibleCasing, casing) > 0) {
                  lowestPossibleCasing = casing;
                }
              }
              if (lowestPossibleCasing !== null) {
                advance(function() {
                  cursor.continue(lowestPossibleCasing + nextKeySuffix);
                });
              } else {
                advance(resolve);
              }
              return false;
            }
          });
          return c3;
        }
        __name(addIgnoreCaseAlgorithm, "addIgnoreCaseAlgorithm");
        function createRange(lower, upper, lowerOpen, upperOpen) {
          return {
            type: 2,
            lower,
            upper,
            lowerOpen,
            upperOpen
          };
        }
        __name(createRange, "createRange");
        function rangeEqual(value) {
          return {
            type: 1,
            lower: value,
            upper: value
          };
        }
        __name(rangeEqual, "rangeEqual");
        var WhereClause = function() {
          function WhereClause2() {
          }
          __name(WhereClause2, "WhereClause");
          Object.defineProperty(WhereClause2.prototype, "Collection", {
            get: /* @__PURE__ */ __name(function() {
              return this._ctx.table.db.Collection;
            }, "get"),
            enumerable: false,
            configurable: true
          });
          WhereClause2.prototype.between = function(lower, upper, includeLower, includeUpper) {
            includeLower = includeLower !== false;
            includeUpper = includeUpper === true;
            try {
              if (this._cmp(lower, upper) > 0 || this._cmp(lower, upper) === 0 && (includeLower || includeUpper) && !(includeLower && includeUpper))
                return emptyCollection(this);
              return new this.Collection(this, function() {
                return createRange(lower, upper, !includeLower, !includeUpper);
              });
            } catch (e3) {
              return fail(this, INVALID_KEY_ARGUMENT);
            }
          };
          WhereClause2.prototype.equals = function(value) {
            if (value == null)
              return fail(this, INVALID_KEY_ARGUMENT);
            return new this.Collection(this, function() {
              return rangeEqual(value);
            });
          };
          WhereClause2.prototype.above = function(value) {
            if (value == null)
              return fail(this, INVALID_KEY_ARGUMENT);
            return new this.Collection(this, function() {
              return createRange(value, void 0, true);
            });
          };
          WhereClause2.prototype.aboveOrEqual = function(value) {
            if (value == null)
              return fail(this, INVALID_KEY_ARGUMENT);
            return new this.Collection(this, function() {
              return createRange(value, void 0, false);
            });
          };
          WhereClause2.prototype.below = function(value) {
            if (value == null)
              return fail(this, INVALID_KEY_ARGUMENT);
            return new this.Collection(this, function() {
              return createRange(void 0, value, false, true);
            });
          };
          WhereClause2.prototype.belowOrEqual = function(value) {
            if (value == null)
              return fail(this, INVALID_KEY_ARGUMENT);
            return new this.Collection(this, function() {
              return createRange(void 0, value);
            });
          };
          WhereClause2.prototype.startsWith = function(str) {
            if (typeof str !== "string")
              return fail(this, STRING_EXPECTED);
            return this.between(str, str + maxString, true, true);
          };
          WhereClause2.prototype.startsWithIgnoreCase = function(str) {
            if (str === "")
              return this.startsWith(str);
            return addIgnoreCaseAlgorithm(this, function(x4, a3) {
              return x4.indexOf(a3[0]) === 0;
            }, [str], maxString);
          };
          WhereClause2.prototype.equalsIgnoreCase = function(str) {
            return addIgnoreCaseAlgorithm(this, function(x4, a3) {
              return x4 === a3[0];
            }, [str], "");
          };
          WhereClause2.prototype.anyOfIgnoreCase = function() {
            var set = getArrayOf.apply(NO_CHAR_ARRAY, arguments);
            if (set.length === 0)
              return emptyCollection(this);
            return addIgnoreCaseAlgorithm(this, function(x4, a3) {
              return a3.indexOf(x4) !== -1;
            }, set, "");
          };
          WhereClause2.prototype.startsWithAnyOfIgnoreCase = function() {
            var set = getArrayOf.apply(NO_CHAR_ARRAY, arguments);
            if (set.length === 0)
              return emptyCollection(this);
            return addIgnoreCaseAlgorithm(this, function(x4, a3) {
              return a3.some(function(n3) {
                return x4.indexOf(n3) === 0;
              });
            }, set, maxString);
          };
          WhereClause2.prototype.anyOf = function() {
            var _this = this;
            var set = getArrayOf.apply(NO_CHAR_ARRAY, arguments);
            var compare = this._cmp;
            try {
              set.sort(compare);
            } catch (e3) {
              return fail(this, INVALID_KEY_ARGUMENT);
            }
            if (set.length === 0)
              return emptyCollection(this);
            var c3 = new this.Collection(this, function() {
              return createRange(set[0], set[set.length - 1]);
            });
            c3._ondirectionchange = function(direction) {
              compare = direction === "next" ? _this._ascending : _this._descending;
              set.sort(compare);
            };
            var i3 = 0;
            c3._addAlgorithm(function(cursor, advance, resolve) {
              var key2 = cursor.key;
              while (compare(key2, set[i3]) > 0) {
                ++i3;
                if (i3 === set.length) {
                  advance(resolve);
                  return false;
                }
              }
              if (compare(key2, set[i3]) === 0) {
                return true;
              } else {
                advance(function() {
                  cursor.continue(set[i3]);
                });
                return false;
              }
            });
            return c3;
          };
          WhereClause2.prototype.notEqual = function(value) {
            return this.inAnyRange([[minKey, value], [value, this.db._maxKey]], { includeLowers: false, includeUppers: false });
          };
          WhereClause2.prototype.noneOf = function() {
            var set = getArrayOf.apply(NO_CHAR_ARRAY, arguments);
            if (set.length === 0)
              return new this.Collection(this);
            try {
              set.sort(this._ascending);
            } catch (e3) {
              return fail(this, INVALID_KEY_ARGUMENT);
            }
            var ranges = set.reduce(function(res, val) {
              return res ? res.concat([[res[res.length - 1][1], val]]) : [[minKey, val]];
            }, null);
            ranges.push([set[set.length - 1], this.db._maxKey]);
            return this.inAnyRange(ranges, { includeLowers: false, includeUppers: false });
          };
          WhereClause2.prototype.inAnyRange = function(ranges, options2) {
            var _this = this;
            var cmp3 = this._cmp, ascending = this._ascending, descending = this._descending, min = this._min, max2 = this._max;
            if (ranges.length === 0)
              return emptyCollection(this);
            if (!ranges.every(function(range) {
              return range[0] !== void 0 && range[1] !== void 0 && ascending(range[0], range[1]) <= 0;
            })) {
              return fail(this, "First argument to inAnyRange() must be an Array of two-value Arrays [lower,upper] where upper must not be lower than lower", exceptions.InvalidArgument);
            }
            var includeLowers = !options2 || options2.includeLowers !== false;
            var includeUppers = options2 && options2.includeUppers === true;
            function addRange2(ranges2, newRange) {
              var i3 = 0, l3 = ranges2.length;
              for (; i3 < l3; ++i3) {
                var range = ranges2[i3];
                if (cmp3(newRange[0], range[1]) < 0 && cmp3(newRange[1], range[0]) > 0) {
                  range[0] = min(range[0], newRange[0]);
                  range[1] = max2(range[1], newRange[1]);
                  break;
                }
              }
              if (i3 === l3)
                ranges2.push(newRange);
              return ranges2;
            }
            __name(addRange2, "addRange");
            var sortDirection = ascending;
            function rangeSorter(a3, b2) {
              return sortDirection(a3[0], b2[0]);
            }
            __name(rangeSorter, "rangeSorter");
            var set;
            try {
              set = ranges.reduce(addRange2, []);
              set.sort(rangeSorter);
            } catch (ex) {
              return fail(this, INVALID_KEY_ARGUMENT);
            }
            var rangePos = 0;
            var keyIsBeyondCurrentEntry = includeUppers ? function(key2) {
              return ascending(key2, set[rangePos][1]) > 0;
            } : function(key2) {
              return ascending(key2, set[rangePos][1]) >= 0;
            };
            var keyIsBeforeCurrentEntry = includeLowers ? function(key2) {
              return descending(key2, set[rangePos][0]) > 0;
            } : function(key2) {
              return descending(key2, set[rangePos][0]) >= 0;
            };
            function keyWithinCurrentRange(key2) {
              return !keyIsBeyondCurrentEntry(key2) && !keyIsBeforeCurrentEntry(key2);
            }
            __name(keyWithinCurrentRange, "keyWithinCurrentRange");
            var checkKey = keyIsBeyondCurrentEntry;
            var c3 = new this.Collection(this, function() {
              return createRange(set[0][0], set[set.length - 1][1], !includeLowers, !includeUppers);
            });
            c3._ondirectionchange = function(direction) {
              if (direction === "next") {
                checkKey = keyIsBeyondCurrentEntry;
                sortDirection = ascending;
              } else {
                checkKey = keyIsBeforeCurrentEntry;
                sortDirection = descending;
              }
              set.sort(rangeSorter);
            };
            c3._addAlgorithm(function(cursor, advance, resolve) {
              var key2 = cursor.key;
              while (checkKey(key2)) {
                ++rangePos;
                if (rangePos === set.length) {
                  advance(resolve);
                  return false;
                }
              }
              if (keyWithinCurrentRange(key2)) {
                return true;
              } else if (_this._cmp(key2, set[rangePos][1]) === 0 || _this._cmp(key2, set[rangePos][0]) === 0) {
                return false;
              } else {
                advance(function() {
                  if (sortDirection === ascending)
                    cursor.continue(set[rangePos][0]);
                  else
                    cursor.continue(set[rangePos][1]);
                });
                return false;
              }
            });
            return c3;
          };
          WhereClause2.prototype.startsWithAnyOf = function() {
            var set = getArrayOf.apply(NO_CHAR_ARRAY, arguments);
            if (!set.every(function(s3) {
              return typeof s3 === "string";
            })) {
              return fail(this, "startsWithAnyOf() only works with strings");
            }
            if (set.length === 0)
              return emptyCollection(this);
            return this.inAnyRange(set.map(function(str) {
              return [str, str + maxString];
            }));
          };
          return WhereClause2;
        }();
        function createWhereClauseConstructor(db) {
          return makeClassConstructor(WhereClause.prototype, /* @__PURE__ */ __name(function WhereClause2(table, index, orCollection) {
            this.db = db;
            this._ctx = {
              table,
              index: index === ":id" ? null : index,
              or: orCollection
            };
            this._cmp = this._ascending = cmp2;
            this._descending = function(a3, b2) {
              return cmp2(b2, a3);
            };
            this._max = function(a3, b2) {
              return cmp2(a3, b2) > 0 ? a3 : b2;
            };
            this._min = function(a3, b2) {
              return cmp2(a3, b2) < 0 ? a3 : b2;
            };
            this._IDBKeyRange = db._deps.IDBKeyRange;
            if (!this._IDBKeyRange)
              throw new exceptions.MissingAPI();
          }, "WhereClause"));
        }
        __name(createWhereClauseConstructor, "createWhereClauseConstructor");
        function eventRejectHandler(reject) {
          return wrap2(function(event) {
            preventDefault2(event);
            reject(event.target.error);
            return false;
          });
        }
        __name(eventRejectHandler, "eventRejectHandler");
        function preventDefault2(event) {
          if (event.stopPropagation)
            event.stopPropagation();
          if (event.preventDefault)
            event.preventDefault();
        }
        __name(preventDefault2, "preventDefault");
        var DEXIE_STORAGE_MUTATED_EVENT_NAME = "storagemutated";
        var STORAGE_MUTATED_DOM_EVENT_NAME = "x-storagemutated-1";
        var globalEvents = Events(null, DEXIE_STORAGE_MUTATED_EVENT_NAME);
        var Transaction = function() {
          function Transaction2() {
          }
          __name(Transaction2, "Transaction");
          Transaction2.prototype._lock = function() {
            assert(!PSD.global);
            ++this._reculock;
            if (this._reculock === 1 && !PSD.global)
              PSD.lockOwnerFor = this;
            return this;
          };
          Transaction2.prototype._unlock = function() {
            assert(!PSD.global);
            if (--this._reculock === 0) {
              if (!PSD.global)
                PSD.lockOwnerFor = null;
              while (this._blockedFuncs.length > 0 && !this._locked()) {
                var fnAndPSD = this._blockedFuncs.shift();
                try {
                  usePSD(fnAndPSD[1], fnAndPSD[0]);
                } catch (e3) {
                }
              }
            }
            return this;
          };
          Transaction2.prototype._locked = function() {
            return this._reculock && PSD.lockOwnerFor !== this;
          };
          Transaction2.prototype.create = function(idbtrans) {
            var _this = this;
            if (!this.mode)
              return this;
            var idbdb = this.db.idbdb;
            var dbOpenError = this.db._state.dbOpenError;
            assert(!this.idbtrans);
            if (!idbtrans && !idbdb) {
              switch (dbOpenError && dbOpenError.name) {
                case "DatabaseClosedError":
                  throw new exceptions.DatabaseClosed(dbOpenError);
                case "MissingAPIError":
                  throw new exceptions.MissingAPI(dbOpenError.message, dbOpenError);
                default:
                  throw new exceptions.OpenFailed(dbOpenError);
              }
            }
            if (!this.active)
              throw new exceptions.TransactionInactive();
            assert(this._completion._state === null);
            idbtrans = this.idbtrans = idbtrans || (this.db.core ? this.db.core.transaction(this.storeNames, this.mode, { durability: this.chromeTransactionDurability }) : idbdb.transaction(this.storeNames, this.mode, { durability: this.chromeTransactionDurability }));
            idbtrans.onerror = wrap2(function(ev) {
              preventDefault2(ev);
              _this._reject(idbtrans.error);
            });
            idbtrans.onabort = wrap2(function(ev) {
              preventDefault2(ev);
              _this.active && _this._reject(new exceptions.Abort(idbtrans.error));
              _this.active = false;
              _this.on("abort").fire(ev);
            });
            idbtrans.oncomplete = wrap2(function() {
              _this.active = false;
              _this._resolve();
              if ("mutatedParts" in idbtrans) {
                globalEvents.storagemutated.fire(idbtrans["mutatedParts"]);
              }
            });
            return this;
          };
          Transaction2.prototype._promise = function(mode, fn2, bWriteLock) {
            var _this = this;
            if (mode === "readwrite" && this.mode !== "readwrite")
              return rejection(new exceptions.ReadOnly("Transaction is readonly"));
            if (!this.active)
              return rejection(new exceptions.TransactionInactive());
            if (this._locked()) {
              return new DexiePromise(function(resolve, reject) {
                _this._blockedFuncs.push([function() {
                  _this._promise(mode, fn2, bWriteLock).then(resolve, reject);
                }, PSD]);
              });
            } else if (bWriteLock) {
              return newScope(function() {
                var p4 = new DexiePromise(function(resolve, reject) {
                  _this._lock();
                  var rv = fn2(resolve, reject, _this);
                  if (rv && rv.then)
                    rv.then(resolve, reject);
                });
                p4.finally(function() {
                  return _this._unlock();
                });
                p4._lib = true;
                return p4;
              });
            } else {
              var p3 = new DexiePromise(function(resolve, reject) {
                var rv = fn2(resolve, reject, _this);
                if (rv && rv.then)
                  rv.then(resolve, reject);
              });
              p3._lib = true;
              return p3;
            }
          };
          Transaction2.prototype._root = function() {
            return this.parent ? this.parent._root() : this;
          };
          Transaction2.prototype.waitFor = function(promiseLike) {
            var root = this._root();
            var promise = DexiePromise.resolve(promiseLike);
            if (root._waitingFor) {
              root._waitingFor = root._waitingFor.then(function() {
                return promise;
              });
            } else {
              root._waitingFor = promise;
              root._waitingQueue = [];
              var store = root.idbtrans.objectStore(root.storeNames[0]);
              (/* @__PURE__ */ __name(function spin() {
                ++root._spinCount;
                while (root._waitingQueue.length)
                  root._waitingQueue.shift()();
                if (root._waitingFor)
                  store.get(-Infinity).onsuccess = spin;
              }, "spin"))();
            }
            var currentWaitPromise = root._waitingFor;
            return new DexiePromise(function(resolve, reject) {
              promise.then(function(res) {
                return root._waitingQueue.push(wrap2(resolve.bind(null, res)));
              }, function(err) {
                return root._waitingQueue.push(wrap2(reject.bind(null, err)));
              }).finally(function() {
                if (root._waitingFor === currentWaitPromise) {
                  root._waitingFor = null;
                }
              });
            });
          };
          Transaction2.prototype.abort = function() {
            if (this.active) {
              this.active = false;
              if (this.idbtrans)
                this.idbtrans.abort();
              this._reject(new exceptions.Abort());
            }
          };
          Transaction2.prototype.table = function(tableName) {
            var memoizedTables = this._memoizedTables || (this._memoizedTables = {});
            if (hasOwn(memoizedTables, tableName))
              return memoizedTables[tableName];
            var tableSchema = this.schema[tableName];
            if (!tableSchema) {
              throw new exceptions.NotFound("Table " + tableName + " not part of transaction");
            }
            var transactionBoundTable = new this.db.Table(tableName, tableSchema, this);
            transactionBoundTable.core = this.db.core.table(tableName);
            memoizedTables[tableName] = transactionBoundTable;
            return transactionBoundTable;
          };
          return Transaction2;
        }();
        function createTransactionConstructor(db) {
          return makeClassConstructor(Transaction.prototype, /* @__PURE__ */ __name(function Transaction2(mode, storeNames, dbschema, chromeTransactionDurability, parent) {
            var _this = this;
            this.db = db;
            this.mode = mode;
            this.storeNames = storeNames;
            this.schema = dbschema;
            this.chromeTransactionDurability = chromeTransactionDurability;
            this.idbtrans = null;
            this.on = Events(this, "complete", "error", "abort");
            this.parent = parent || null;
            this.active = true;
            this._reculock = 0;
            this._blockedFuncs = [];
            this._resolve = null;
            this._reject = null;
            this._waitingFor = null;
            this._waitingQueue = null;
            this._spinCount = 0;
            this._completion = new DexiePromise(function(resolve, reject) {
              _this._resolve = resolve;
              _this._reject = reject;
            });
            this._completion.then(function() {
              _this.active = false;
              _this.on.complete.fire();
            }, function(e3) {
              var wasActive = _this.active;
              _this.active = false;
              _this.on.error.fire(e3);
              _this.parent ? _this.parent._reject(e3) : wasActive && _this.idbtrans && _this.idbtrans.abort();
              return rejection(e3);
            });
          }, "Transaction"));
        }
        __name(createTransactionConstructor, "createTransactionConstructor");
        function createIndexSpec(name, keyPath, unique, multi, auto, compound, isPrimKey) {
          return {
            name,
            keyPath,
            unique,
            multi,
            auto,
            compound,
            src: (unique && !isPrimKey ? "&" : "") + (multi ? "*" : "") + (auto ? "++" : "") + nameFromKeyPath(keyPath)
          };
        }
        __name(createIndexSpec, "createIndexSpec");
        function nameFromKeyPath(keyPath) {
          return typeof keyPath === "string" ? keyPath : keyPath ? "[" + [].join.call(keyPath, "+") + "]" : "";
        }
        __name(nameFromKeyPath, "nameFromKeyPath");
        function createTableSchema(name, primKey, indexes) {
          return {
            name,
            primKey,
            indexes,
            mappedClass: null,
            idxByName: arrayToObject(indexes, function(index) {
              return [index.name, index];
            })
          };
        }
        __name(createTableSchema, "createTableSchema");
        function safariMultiStoreFix(storeNames) {
          return storeNames.length === 1 ? storeNames[0] : storeNames;
        }
        __name(safariMultiStoreFix, "safariMultiStoreFix");
        var getMaxKey = /* @__PURE__ */ __name(function(IdbKeyRange) {
          try {
            IdbKeyRange.only([[]]);
            getMaxKey = /* @__PURE__ */ __name(function() {
              return [[]];
            }, "getMaxKey");
            return [[]];
          } catch (e3) {
            getMaxKey = /* @__PURE__ */ __name(function() {
              return maxString;
            }, "getMaxKey");
            return maxString;
          }
        }, "getMaxKey");
        function getKeyExtractor(keyPath) {
          if (keyPath == null) {
            return function() {
              return void 0;
            };
          } else if (typeof keyPath === "string") {
            return getSinglePathKeyExtractor(keyPath);
          } else {
            return function(obj) {
              return getByKeyPath(obj, keyPath);
            };
          }
        }
        __name(getKeyExtractor, "getKeyExtractor");
        function getSinglePathKeyExtractor(keyPath) {
          var split = keyPath.split(".");
          if (split.length === 1) {
            return function(obj) {
              return obj[keyPath];
            };
          } else {
            return function(obj) {
              return getByKeyPath(obj, keyPath);
            };
          }
        }
        __name(getSinglePathKeyExtractor, "getSinglePathKeyExtractor");
        function arrayify(arrayLike) {
          return [].slice.call(arrayLike);
        }
        __name(arrayify, "arrayify");
        var _id_counter = 0;
        function getKeyPathAlias(keyPath) {
          return keyPath == null ? ":id" : typeof keyPath === "string" ? keyPath : "[".concat(keyPath.join("+"), "]");
        }
        __name(getKeyPathAlias, "getKeyPathAlias");
        function createDBCore(db, IdbKeyRange, tmpTrans) {
          function extractSchema(db2, trans) {
            var tables2 = arrayify(db2.objectStoreNames);
            return {
              schema: {
                name: db2.name,
                tables: tables2.map(function(table) {
                  return trans.objectStore(table);
                }).map(function(store) {
                  var keyPath = store.keyPath, autoIncrement = store.autoIncrement;
                  var compound = isArray(keyPath);
                  var outbound = keyPath == null;
                  var indexByKeyPath = {};
                  var result = {
                    name: store.name,
                    primaryKey: {
                      name: null,
                      isPrimaryKey: true,
                      outbound,
                      compound,
                      keyPath,
                      autoIncrement,
                      unique: true,
                      extractKey: getKeyExtractor(keyPath)
                    },
                    indexes: arrayify(store.indexNames).map(function(indexName) {
                      return store.index(indexName);
                    }).map(function(index) {
                      var name = index.name, unique = index.unique, multiEntry = index.multiEntry, keyPath2 = index.keyPath;
                      var compound2 = isArray(keyPath2);
                      var result2 = {
                        name,
                        compound: compound2,
                        keyPath: keyPath2,
                        unique,
                        multiEntry,
                        extractKey: getKeyExtractor(keyPath2)
                      };
                      indexByKeyPath[getKeyPathAlias(keyPath2)] = result2;
                      return result2;
                    }),
                    getIndexByKeyPath: /* @__PURE__ */ __name(function(keyPath2) {
                      return indexByKeyPath[getKeyPathAlias(keyPath2)];
                    }, "getIndexByKeyPath")
                  };
                  indexByKeyPath[":id"] = result.primaryKey;
                  if (keyPath != null) {
                    indexByKeyPath[getKeyPathAlias(keyPath)] = result.primaryKey;
                  }
                  return result;
                })
              },
              hasGetAll: tables2.length > 0 && "getAll" in trans.objectStore(tables2[0]) && !(typeof navigator !== "undefined" && /Safari/.test(navigator.userAgent) && !/(Chrome\/|Edge\/)/.test(navigator.userAgent) && [].concat(navigator.userAgent.match(/Safari\/(\d*)/))[1] < 604)
            };
          }
          __name(extractSchema, "extractSchema");
          function makeIDBKeyRange(range) {
            if (range.type === 3)
              return null;
            if (range.type === 4)
              throw new Error("Cannot convert never type to IDBKeyRange");
            var lower = range.lower, upper = range.upper, lowerOpen = range.lowerOpen, upperOpen = range.upperOpen;
            var idbRange = lower === void 0 ? upper === void 0 ? null : IdbKeyRange.upperBound(upper, !!upperOpen) : upper === void 0 ? IdbKeyRange.lowerBound(lower, !!lowerOpen) : IdbKeyRange.bound(lower, upper, !!lowerOpen, !!upperOpen);
            return idbRange;
          }
          __name(makeIDBKeyRange, "makeIDBKeyRange");
          function createDbCoreTable(tableSchema) {
            var tableName = tableSchema.name;
            function mutate(_a3) {
              var trans = _a3.trans, type2 = _a3.type, keys2 = _a3.keys, values = _a3.values, range = _a3.range;
              return new Promise(function(resolve, reject) {
                resolve = wrap2(resolve);
                var store = trans.objectStore(tableName);
                var outbound = store.keyPath == null;
                var isAddOrPut = type2 === "put" || type2 === "add";
                if (!isAddOrPut && type2 !== "delete" && type2 !== "deleteRange")
                  throw new Error("Invalid operation type: " + type2);
                var length = (keys2 || values || { length: 1 }).length;
                if (keys2 && values && keys2.length !== values.length) {
                  throw new Error("Given keys array must have same length as given values array.");
                }
                if (length === 0)
                  return resolve({ numFailures: 0, failures: {}, results: [], lastResult: void 0 });
                var req;
                var reqs = [];
                var failures = [];
                var numFailures = 0;
                var errorHandler = /* @__PURE__ */ __name(function(event) {
                  ++numFailures;
                  preventDefault2(event);
                }, "errorHandler");
                if (type2 === "deleteRange") {
                  if (range.type === 4)
                    return resolve({ numFailures, failures, results: [], lastResult: void 0 });
                  if (range.type === 3)
                    reqs.push(req = store.clear());
                  else
                    reqs.push(req = store.delete(makeIDBKeyRange(range)));
                } else {
                  var _a4 = isAddOrPut ? outbound ? [values, keys2] : [values, null] : [keys2, null], args1 = _a4[0], args2 = _a4[1];
                  if (isAddOrPut) {
                    for (var i3 = 0; i3 < length; ++i3) {
                      reqs.push(req = args2 && args2[i3] !== void 0 ? store[type2](args1[i3], args2[i3]) : store[type2](args1[i3]));
                      req.onerror = errorHandler;
                    }
                  } else {
                    for (var i3 = 0; i3 < length; ++i3) {
                      reqs.push(req = store[type2](args1[i3]));
                      req.onerror = errorHandler;
                    }
                  }
                }
                var done = /* @__PURE__ */ __name(function(event) {
                  var lastResult = event.target.result;
                  reqs.forEach(function(req2, i4) {
                    return req2.error != null && (failures[i4] = req2.error);
                  });
                  resolve({
                    numFailures,
                    failures,
                    results: type2 === "delete" ? keys2 : reqs.map(function(req2) {
                      return req2.result;
                    }),
                    lastResult
                  });
                }, "done");
                req.onerror = function(event) {
                  errorHandler(event);
                  done(event);
                };
                req.onsuccess = done;
              });
            }
            __name(mutate, "mutate");
            function openCursor2(_a3) {
              var trans = _a3.trans, values = _a3.values, query2 = _a3.query, reverse = _a3.reverse, unique = _a3.unique;
              return new Promise(function(resolve, reject) {
                resolve = wrap2(resolve);
                var index = query2.index, range = query2.range;
                var store = trans.objectStore(tableName);
                var source = index.isPrimaryKey ? store : store.index(index.name);
                var direction = reverse ? unique ? "prevunique" : "prev" : unique ? "nextunique" : "next";
                var req = values || !("openKeyCursor" in source) ? source.openCursor(makeIDBKeyRange(range), direction) : source.openKeyCursor(makeIDBKeyRange(range), direction);
                req.onerror = eventRejectHandler(reject);
                req.onsuccess = wrap2(function(ev) {
                  var cursor = req.result;
                  if (!cursor) {
                    resolve(null);
                    return;
                  }
                  cursor.___id = ++_id_counter;
                  cursor.done = false;
                  var _cursorContinue = cursor.continue.bind(cursor);
                  var _cursorContinuePrimaryKey = cursor.continuePrimaryKey;
                  if (_cursorContinuePrimaryKey)
                    _cursorContinuePrimaryKey = _cursorContinuePrimaryKey.bind(cursor);
                  var _cursorAdvance = cursor.advance.bind(cursor);
                  var doThrowCursorIsNotStarted = /* @__PURE__ */ __name(function() {
                    throw new Error("Cursor not started");
                  }, "doThrowCursorIsNotStarted");
                  var doThrowCursorIsStopped = /* @__PURE__ */ __name(function() {
                    throw new Error("Cursor not stopped");
                  }, "doThrowCursorIsStopped");
                  cursor.trans = trans;
                  cursor.stop = cursor.continue = cursor.continuePrimaryKey = cursor.advance = doThrowCursorIsNotStarted;
                  cursor.fail = wrap2(reject);
                  cursor.next = function() {
                    var _this = this;
                    var gotOne = 1;
                    return this.start(function() {
                      return gotOne-- ? _this.continue() : _this.stop();
                    }).then(function() {
                      return _this;
                    });
                  };
                  cursor.start = function(callback) {
                    var iterationPromise = new Promise(function(resolveIteration, rejectIteration) {
                      resolveIteration = wrap2(resolveIteration);
                      req.onerror = eventRejectHandler(rejectIteration);
                      cursor.fail = rejectIteration;
                      cursor.stop = function(value) {
                        cursor.stop = cursor.continue = cursor.continuePrimaryKey = cursor.advance = doThrowCursorIsStopped;
                        resolveIteration(value);
                      };
                    });
                    var guardedCallback = /* @__PURE__ */ __name(function() {
                      if (req.result) {
                        try {
                          callback();
                        } catch (err) {
                          cursor.fail(err);
                        }
                      } else {
                        cursor.done = true;
                        cursor.start = function() {
                          throw new Error("Cursor behind last entry");
                        };
                        cursor.stop();
                      }
                    }, "guardedCallback");
                    req.onsuccess = wrap2(function(ev2) {
                      req.onsuccess = guardedCallback;
                      guardedCallback();
                    });
                    cursor.continue = _cursorContinue;
                    cursor.continuePrimaryKey = _cursorContinuePrimaryKey;
                    cursor.advance = _cursorAdvance;
                    guardedCallback();
                    return iterationPromise;
                  };
                  resolve(cursor);
                }, reject);
              });
            }
            __name(openCursor2, "openCursor");
            function query(hasGetAll2) {
              return function(request) {
                return new Promise(function(resolve, reject) {
                  resolve = wrap2(resolve);
                  var trans = request.trans, values = request.values, limit = request.limit, query2 = request.query;
                  var nonInfinitLimit = limit === Infinity ? void 0 : limit;
                  var index = query2.index, range = query2.range;
                  var store = trans.objectStore(tableName);
                  var source = index.isPrimaryKey ? store : store.index(index.name);
                  var idbKeyRange = makeIDBKeyRange(range);
                  if (limit === 0)
                    return resolve({ result: [] });
                  if (hasGetAll2) {
                    var req = values ? source.getAll(idbKeyRange, nonInfinitLimit) : source.getAllKeys(idbKeyRange, nonInfinitLimit);
                    req.onsuccess = function(event) {
                      return resolve({ result: event.target.result });
                    };
                    req.onerror = eventRejectHandler(reject);
                  } else {
                    var count_1 = 0;
                    var req_1 = values || !("openKeyCursor" in source) ? source.openCursor(idbKeyRange) : source.openKeyCursor(idbKeyRange);
                    var result_1 = [];
                    req_1.onsuccess = function(event) {
                      var cursor = req_1.result;
                      if (!cursor)
                        return resolve({ result: result_1 });
                      result_1.push(values ? cursor.value : cursor.primaryKey);
                      if (++count_1 === limit)
                        return resolve({ result: result_1 });
                      cursor.continue();
                    };
                    req_1.onerror = eventRejectHandler(reject);
                  }
                });
              };
            }
            __name(query, "query");
            return {
              name: tableName,
              schema: tableSchema,
              mutate,
              getMany: /* @__PURE__ */ __name(function(_a3) {
                var trans = _a3.trans, keys2 = _a3.keys;
                return new Promise(function(resolve, reject) {
                  resolve = wrap2(resolve);
                  var store = trans.objectStore(tableName);
                  var length = keys2.length;
                  var result = new Array(length);
                  var keyCount = 0;
                  var callbackCount = 0;
                  var req;
                  var successHandler = /* @__PURE__ */ __name(function(event) {
                    var req2 = event.target;
                    if ((result[req2._pos] = req2.result) != null)
                      ;
                    if (++callbackCount === keyCount)
                      resolve(result);
                  }, "successHandler");
                  var errorHandler = eventRejectHandler(reject);
                  for (var i3 = 0; i3 < length; ++i3) {
                    var key2 = keys2[i3];
                    if (key2 != null) {
                      req = store.get(keys2[i3]);
                      req._pos = i3;
                      req.onsuccess = successHandler;
                      req.onerror = errorHandler;
                      ++keyCount;
                    }
                  }
                  if (keyCount === 0)
                    resolve(result);
                });
              }, "getMany"),
              get: /* @__PURE__ */ __name(function(_a3) {
                var trans = _a3.trans, key2 = _a3.key;
                return new Promise(function(resolve, reject) {
                  resolve = wrap2(resolve);
                  var store = trans.objectStore(tableName);
                  var req = store.get(key2);
                  req.onsuccess = function(event) {
                    return resolve(event.target.result);
                  };
                  req.onerror = eventRejectHandler(reject);
                });
              }, "get"),
              query: query(hasGetAll),
              openCursor: openCursor2,
              count: /* @__PURE__ */ __name(function(_a3) {
                var query2 = _a3.query, trans = _a3.trans;
                var index = query2.index, range = query2.range;
                return new Promise(function(resolve, reject) {
                  var store = trans.objectStore(tableName);
                  var source = index.isPrimaryKey ? store : store.index(index.name);
                  var idbKeyRange = makeIDBKeyRange(range);
                  var req = idbKeyRange ? source.count(idbKeyRange) : source.count();
                  req.onsuccess = wrap2(function(ev) {
                    return resolve(ev.target.result);
                  });
                  req.onerror = eventRejectHandler(reject);
                });
              }, "count")
            };
          }
          __name(createDbCoreTable, "createDbCoreTable");
          var _a2 = extractSchema(db, tmpTrans), schema = _a2.schema, hasGetAll = _a2.hasGetAll;
          var tables = schema.tables.map(function(tableSchema) {
            return createDbCoreTable(tableSchema);
          });
          var tableMap = {};
          tables.forEach(function(table) {
            return tableMap[table.name] = table;
          });
          return {
            stack: "dbcore",
            transaction: db.transaction.bind(db),
            table: /* @__PURE__ */ __name(function(name) {
              var result = tableMap[name];
              if (!result)
                throw new Error("Table '".concat(name, "' not found"));
              return tableMap[name];
            }, "table"),
            MIN_KEY: -Infinity,
            MAX_KEY: getMaxKey(IdbKeyRange),
            schema
          };
        }
        __name(createDBCore, "createDBCore");
        function createMiddlewareStack(stackImpl, middlewares) {
          return middlewares.reduce(function(down, _a2) {
            var create = _a2.create;
            return __assign(__assign({}, down), create(down));
          }, stackImpl);
        }
        __name(createMiddlewareStack, "createMiddlewareStack");
        function createMiddlewareStacks(middlewares, idbdb, _a2, tmpTrans) {
          var IDBKeyRange = _a2.IDBKeyRange;
          _a2.indexedDB;
          var dbcore = createMiddlewareStack(createDBCore(idbdb, IDBKeyRange, tmpTrans), middlewares.dbcore);
          return {
            dbcore
          };
        }
        __name(createMiddlewareStacks, "createMiddlewareStacks");
        function generateMiddlewareStacks(db, tmpTrans) {
          var idbdb = tmpTrans.db;
          var stacks = createMiddlewareStacks(db._middlewares, idbdb, db._deps, tmpTrans);
          db.core = stacks.dbcore;
          db.tables.forEach(function(table) {
            var tableName = table.name;
            if (db.core.schema.tables.some(function(tbl) {
              return tbl.name === tableName;
            })) {
              table.core = db.core.table(tableName);
              if (db[tableName] instanceof db.Table) {
                db[tableName].core = table.core;
              }
            }
          });
        }
        __name(generateMiddlewareStacks, "generateMiddlewareStacks");
        function setApiOnPlace(db, objs, tableNames, dbschema) {
          tableNames.forEach(function(tableName) {
            var schema = dbschema[tableName];
            objs.forEach(function(obj) {
              var propDesc = getPropertyDescriptor(obj, tableName);
              if (!propDesc || "value" in propDesc && propDesc.value === void 0) {
                if (obj === db.Transaction.prototype || obj instanceof db.Transaction) {
                  setProp(obj, tableName, {
                    get: /* @__PURE__ */ __name(function() {
                      return this.table(tableName);
                    }, "get"),
                    set: /* @__PURE__ */ __name(function(value) {
                      defineProperty(this, tableName, { value, writable: true, configurable: true, enumerable: true });
                    }, "set")
                  });
                } else {
                  obj[tableName] = new db.Table(tableName, schema);
                }
              }
            });
          });
        }
        __name(setApiOnPlace, "setApiOnPlace");
        function removeTablesApi(db, objs) {
          objs.forEach(function(obj) {
            for (var key2 in obj) {
              if (obj[key2] instanceof db.Table)
                delete obj[key2];
            }
          });
        }
        __name(removeTablesApi, "removeTablesApi");
        function lowerVersionFirst(a3, b2) {
          return a3._cfg.version - b2._cfg.version;
        }
        __name(lowerVersionFirst, "lowerVersionFirst");
        function runUpgraders(db, oldVersion, idbUpgradeTrans, reject) {
          var globalSchema = db._dbSchema;
          if (idbUpgradeTrans.objectStoreNames.contains("$meta") && !globalSchema.$meta) {
            globalSchema.$meta = createTableSchema("$meta", parseIndexSyntax("")[0], []);
            db._storeNames.push("$meta");
          }
          var trans = db._createTransaction("readwrite", db._storeNames, globalSchema);
          trans.create(idbUpgradeTrans);
          trans._completion.catch(reject);
          var rejectTransaction = trans._reject.bind(trans);
          var transless = PSD.transless || PSD;
          newScope(function() {
            PSD.trans = trans;
            PSD.transless = transless;
            if (oldVersion === 0) {
              keys(globalSchema).forEach(function(tableName) {
                createTable(idbUpgradeTrans, tableName, globalSchema[tableName].primKey, globalSchema[tableName].indexes);
              });
              generateMiddlewareStacks(db, idbUpgradeTrans);
              DexiePromise.follow(function() {
                return db.on.populate.fire(trans);
              }).catch(rejectTransaction);
            } else {
              generateMiddlewareStacks(db, idbUpgradeTrans);
              return getExistingVersion(db, trans, oldVersion).then(function(oldVersion2) {
                return updateTablesAndIndexes(db, oldVersion2, trans, idbUpgradeTrans);
              }).catch(rejectTransaction);
            }
          });
        }
        __name(runUpgraders, "runUpgraders");
        function patchCurrentVersion(db, idbUpgradeTrans) {
          createMissingTables(db._dbSchema, idbUpgradeTrans);
          if (idbUpgradeTrans.db.version % 10 === 0 && !idbUpgradeTrans.objectStoreNames.contains("$meta")) {
            idbUpgradeTrans.db.createObjectStore("$meta").add(Math.ceil(idbUpgradeTrans.db.version / 10 - 1), "version");
          }
          var globalSchema = buildGlobalSchema(db, db.idbdb, idbUpgradeTrans);
          adjustToExistingIndexNames(db, db._dbSchema, idbUpgradeTrans);
          var diff = getSchemaDiff(globalSchema, db._dbSchema);
          var _loop_1 = /* @__PURE__ */ __name(function(tableChange2) {
            if (tableChange2.change.length || tableChange2.recreate) {
              console.warn("Unable to patch indexes of table ".concat(tableChange2.name, " because it has changes on the type of index or primary key."));
              return { value: void 0 };
            }
            var store = idbUpgradeTrans.objectStore(tableChange2.name);
            tableChange2.add.forEach(function(idx) {
              if (debug)
                console.debug("Dexie upgrade patch: Creating missing index ".concat(tableChange2.name, ".").concat(idx.src));
              addIndex(store, idx);
            });
          }, "_loop_1");
          for (var _i = 0, _a2 = diff.change; _i < _a2.length; _i++) {
            var tableChange = _a2[_i];
            var state_1 = _loop_1(tableChange);
            if (typeof state_1 === "object")
              return state_1.value;
          }
        }
        __name(patchCurrentVersion, "patchCurrentVersion");
        function getExistingVersion(db, trans, oldVersion) {
          if (trans.storeNames.includes("$meta")) {
            return trans.table("$meta").get("version").then(function(metaVersion) {
              return metaVersion != null ? metaVersion : oldVersion;
            });
          } else {
            return DexiePromise.resolve(oldVersion);
          }
        }
        __name(getExistingVersion, "getExistingVersion");
        function updateTablesAndIndexes(db, oldVersion, trans, idbUpgradeTrans) {
          var queue = [];
          var versions = db._versions;
          var globalSchema = db._dbSchema = buildGlobalSchema(db, db.idbdb, idbUpgradeTrans);
          var versToRun = versions.filter(function(v3) {
            return v3._cfg.version >= oldVersion;
          });
          if (versToRun.length === 0) {
            return DexiePromise.resolve();
          }
          versToRun.forEach(function(version) {
            queue.push(function() {
              var oldSchema = globalSchema;
              var newSchema = version._cfg.dbschema;
              adjustToExistingIndexNames(db, oldSchema, idbUpgradeTrans);
              adjustToExistingIndexNames(db, newSchema, idbUpgradeTrans);
              globalSchema = db._dbSchema = newSchema;
              var diff = getSchemaDiff(oldSchema, newSchema);
              diff.add.forEach(function(tuple) {
                createTable(idbUpgradeTrans, tuple[0], tuple[1].primKey, tuple[1].indexes);
              });
              diff.change.forEach(function(change) {
                if (change.recreate) {
                  throw new exceptions.Upgrade("Not yet support for changing primary key");
                } else {
                  var store_1 = idbUpgradeTrans.objectStore(change.name);
                  change.add.forEach(function(idx) {
                    return addIndex(store_1, idx);
                  });
                  change.change.forEach(function(idx) {
                    store_1.deleteIndex(idx.name);
                    addIndex(store_1, idx);
                  });
                  change.del.forEach(function(idxName) {
                    return store_1.deleteIndex(idxName);
                  });
                }
              });
              var contentUpgrade = version._cfg.contentUpgrade;
              if (contentUpgrade && version._cfg.version > oldVersion) {
                generateMiddlewareStacks(db, idbUpgradeTrans);
                trans._memoizedTables = {};
                var upgradeSchema_1 = shallowClone(newSchema);
                diff.del.forEach(function(table) {
                  upgradeSchema_1[table] = oldSchema[table];
                });
                removeTablesApi(db, [db.Transaction.prototype]);
                setApiOnPlace(db, [db.Transaction.prototype], keys(upgradeSchema_1), upgradeSchema_1);
                trans.schema = upgradeSchema_1;
                var contentUpgradeIsAsync_1 = isAsyncFunction(contentUpgrade);
                if (contentUpgradeIsAsync_1) {
                  incrementExpectedAwaits();
                }
                var returnValue_1;
                var promiseFollowed = DexiePromise.follow(function() {
                  returnValue_1 = contentUpgrade(trans);
                  if (returnValue_1) {
                    if (contentUpgradeIsAsync_1) {
                      var decrementor = decrementExpectedAwaits.bind(null, null);
                      returnValue_1.then(decrementor, decrementor);
                    }
                  }
                });
                return returnValue_1 && typeof returnValue_1.then === "function" ? DexiePromise.resolve(returnValue_1) : promiseFollowed.then(function() {
                  return returnValue_1;
                });
              }
            });
            queue.push(function(idbtrans) {
              var newSchema = version._cfg.dbschema;
              deleteRemovedTables(newSchema, idbtrans);
              removeTablesApi(db, [db.Transaction.prototype]);
              setApiOnPlace(db, [db.Transaction.prototype], db._storeNames, db._dbSchema);
              trans.schema = db._dbSchema;
            });
            queue.push(function(idbtrans) {
              if (db.idbdb.objectStoreNames.contains("$meta")) {
                if (Math.ceil(db.idbdb.version / 10) === version._cfg.version) {
                  db.idbdb.deleteObjectStore("$meta");
                  delete db._dbSchema.$meta;
                  db._storeNames = db._storeNames.filter(function(name) {
                    return name !== "$meta";
                  });
                } else {
                  idbtrans.objectStore("$meta").put(version._cfg.version, "version");
                }
              }
            });
          });
          function runQueue() {
            return queue.length ? DexiePromise.resolve(queue.shift()(trans.idbtrans)).then(runQueue) : DexiePromise.resolve();
          }
          __name(runQueue, "runQueue");
          return runQueue().then(function() {
            createMissingTables(globalSchema, idbUpgradeTrans);
          });
        }
        __name(updateTablesAndIndexes, "updateTablesAndIndexes");
        function getSchemaDiff(oldSchema, newSchema) {
          var diff = {
            del: [],
            add: [],
            change: []
          };
          var table;
          for (table in oldSchema) {
            if (!newSchema[table])
              diff.del.push(table);
          }
          for (table in newSchema) {
            var oldDef = oldSchema[table], newDef = newSchema[table];
            if (!oldDef) {
              diff.add.push([table, newDef]);
            } else {
              var change = {
                name: table,
                def: newDef,
                recreate: false,
                del: [],
                add: [],
                change: []
              };
              if ("" + (oldDef.primKey.keyPath || "") !== "" + (newDef.primKey.keyPath || "") || oldDef.primKey.auto !== newDef.primKey.auto) {
                change.recreate = true;
                diff.change.push(change);
              } else {
                var oldIndexes = oldDef.idxByName;
                var newIndexes = newDef.idxByName;
                var idxName = void 0;
                for (idxName in oldIndexes) {
                  if (!newIndexes[idxName])
                    change.del.push(idxName);
                }
                for (idxName in newIndexes) {
                  var oldIdx = oldIndexes[idxName], newIdx = newIndexes[idxName];
                  if (!oldIdx)
                    change.add.push(newIdx);
                  else if (oldIdx.src !== newIdx.src)
                    change.change.push(newIdx);
                }
                if (change.del.length > 0 || change.add.length > 0 || change.change.length > 0) {
                  diff.change.push(change);
                }
              }
            }
          }
          return diff;
        }
        __name(getSchemaDiff, "getSchemaDiff");
        function createTable(idbtrans, tableName, primKey, indexes) {
          var store = idbtrans.db.createObjectStore(tableName, primKey.keyPath ? { keyPath: primKey.keyPath, autoIncrement: primKey.auto } : { autoIncrement: primKey.auto });
          indexes.forEach(function(idx) {
            return addIndex(store, idx);
          });
          return store;
        }
        __name(createTable, "createTable");
        function createMissingTables(newSchema, idbtrans) {
          keys(newSchema).forEach(function(tableName) {
            if (!idbtrans.db.objectStoreNames.contains(tableName)) {
              if (debug)
                console.debug("Dexie: Creating missing table", tableName);
              createTable(idbtrans, tableName, newSchema[tableName].primKey, newSchema[tableName].indexes);
            }
          });
        }
        __name(createMissingTables, "createMissingTables");
        function deleteRemovedTables(newSchema, idbtrans) {
          [].slice.call(idbtrans.db.objectStoreNames).forEach(function(storeName) {
            return newSchema[storeName] == null && idbtrans.db.deleteObjectStore(storeName);
          });
        }
        __name(deleteRemovedTables, "deleteRemovedTables");
        function addIndex(store, idx) {
          store.createIndex(idx.name, idx.keyPath, { unique: idx.unique, multiEntry: idx.multi });
        }
        __name(addIndex, "addIndex");
        function buildGlobalSchema(db, idbdb, tmpTrans) {
          var globalSchema = {};
          var dbStoreNames = slice(idbdb.objectStoreNames, 0);
          dbStoreNames.forEach(function(storeName) {
            var store = tmpTrans.objectStore(storeName);
            var keyPath = store.keyPath;
            var primKey = createIndexSpec(nameFromKeyPath(keyPath), keyPath || "", true, false, !!store.autoIncrement, keyPath && typeof keyPath !== "string", true);
            var indexes = [];
            for (var j4 = 0; j4 < store.indexNames.length; ++j4) {
              var idbindex = store.index(store.indexNames[j4]);
              keyPath = idbindex.keyPath;
              var index = createIndexSpec(idbindex.name, keyPath, !!idbindex.unique, !!idbindex.multiEntry, false, keyPath && typeof keyPath !== "string", false);
              indexes.push(index);
            }
            globalSchema[storeName] = createTableSchema(storeName, primKey, indexes);
          });
          return globalSchema;
        }
        __name(buildGlobalSchema, "buildGlobalSchema");
        function readGlobalSchema(db, idbdb, tmpTrans) {
          db.verno = idbdb.version / 10;
          var globalSchema = db._dbSchema = buildGlobalSchema(db, idbdb, tmpTrans);
          db._storeNames = slice(idbdb.objectStoreNames, 0);
          setApiOnPlace(db, [db._allTables], keys(globalSchema), globalSchema);
        }
        __name(readGlobalSchema, "readGlobalSchema");
        function verifyInstalledSchema(db, tmpTrans) {
          var installedSchema = buildGlobalSchema(db, db.idbdb, tmpTrans);
          var diff = getSchemaDiff(installedSchema, db._dbSchema);
          return !(diff.add.length || diff.change.some(function(ch) {
            return ch.add.length || ch.change.length;
          }));
        }
        __name(verifyInstalledSchema, "verifyInstalledSchema");
        function adjustToExistingIndexNames(db, schema, idbtrans) {
          var storeNames = idbtrans.db.objectStoreNames;
          for (var i3 = 0; i3 < storeNames.length; ++i3) {
            var storeName = storeNames[i3];
            var store = idbtrans.objectStore(storeName);
            db._hasGetAll = "getAll" in store;
            for (var j4 = 0; j4 < store.indexNames.length; ++j4) {
              var indexName = store.indexNames[j4];
              var keyPath = store.index(indexName).keyPath;
              var dexieName = typeof keyPath === "string" ? keyPath : "[" + slice(keyPath).join("+") + "]";
              if (schema[storeName]) {
                var indexSpec = schema[storeName].idxByName[dexieName];
                if (indexSpec) {
                  indexSpec.name = indexName;
                  delete schema[storeName].idxByName[dexieName];
                  schema[storeName].idxByName[indexName] = indexSpec;
                }
              }
            }
          }
          if (typeof navigator !== "undefined" && /Safari/.test(navigator.userAgent) && !/(Chrome\/|Edge\/)/.test(navigator.userAgent) && _global.WorkerGlobalScope && _global instanceof _global.WorkerGlobalScope && [].concat(navigator.userAgent.match(/Safari\/(\d*)/))[1] < 604) {
            db._hasGetAll = false;
          }
        }
        __name(adjustToExistingIndexNames, "adjustToExistingIndexNames");
        function parseIndexSyntax(primKeyAndIndexes) {
          return primKeyAndIndexes.split(",").map(function(index, indexNum) {
            index = index.trim();
            var name = index.replace(/([&*]|\+\+)/g, "");
            var keyPath = /^\[/.test(name) ? name.match(/^\[(.*)\]$/)[1].split("+") : name;
            return createIndexSpec(name, keyPath || null, /\&/.test(index), /\*/.test(index), /\+\+/.test(index), isArray(keyPath), indexNum === 0);
          });
        }
        __name(parseIndexSyntax, "parseIndexSyntax");
        var Version = function() {
          function Version2() {
          }
          __name(Version2, "Version");
          Version2.prototype._parseStoresSpec = function(stores, outSchema) {
            keys(stores).forEach(function(tableName) {
              if (stores[tableName] !== null) {
                var indexes = parseIndexSyntax(stores[tableName]);
                var primKey = indexes.shift();
                primKey.unique = true;
                if (primKey.multi)
                  throw new exceptions.Schema("Primary key cannot be multi-valued");
                indexes.forEach(function(idx) {
                  if (idx.auto)
                    throw new exceptions.Schema("Only primary key can be marked as autoIncrement (++)");
                  if (!idx.keyPath)
                    throw new exceptions.Schema("Index must have a name and cannot be an empty string");
                });
                outSchema[tableName] = createTableSchema(tableName, primKey, indexes);
              }
            });
          };
          Version2.prototype.stores = function(stores) {
            var db = this.db;
            this._cfg.storesSource = this._cfg.storesSource ? extend(this._cfg.storesSource, stores) : stores;
            var versions = db._versions;
            var storesSpec = {};
            var dbschema = {};
            versions.forEach(function(version) {
              extend(storesSpec, version._cfg.storesSource);
              dbschema = version._cfg.dbschema = {};
              version._parseStoresSpec(storesSpec, dbschema);
            });
            db._dbSchema = dbschema;
            removeTablesApi(db, [db._allTables, db, db.Transaction.prototype]);
            setApiOnPlace(db, [db._allTables, db, db.Transaction.prototype, this._cfg.tables], keys(dbschema), dbschema);
            db._storeNames = keys(dbschema);
            return this;
          };
          Version2.prototype.upgrade = function(upgradeFunction) {
            this._cfg.contentUpgrade = promisableChain(this._cfg.contentUpgrade || nop, upgradeFunction);
            return this;
          };
          return Version2;
        }();
        function createVersionConstructor(db) {
          return makeClassConstructor(Version.prototype, /* @__PURE__ */ __name(function Version2(versionNumber) {
            this.db = db;
            this._cfg = {
              version: versionNumber,
              storesSource: null,
              dbschema: {},
              tables: {},
              contentUpgrade: null
            };
          }, "Version"));
        }
        __name(createVersionConstructor, "createVersionConstructor");
        function getDbNamesTable(indexedDB2, IDBKeyRange) {
          var dbNamesDB = indexedDB2["_dbNamesDB"];
          if (!dbNamesDB) {
            dbNamesDB = indexedDB2["_dbNamesDB"] = new Dexie$1(DBNAMES_DB, {
              addons: [],
              indexedDB: indexedDB2,
              IDBKeyRange
            });
            dbNamesDB.version(1).stores({ dbnames: "name" });
          }
          return dbNamesDB.table("dbnames");
        }
        __name(getDbNamesTable, "getDbNamesTable");
        function hasDatabasesNative(indexedDB2) {
          return indexedDB2 && typeof indexedDB2.databases === "function";
        }
        __name(hasDatabasesNative, "hasDatabasesNative");
        function getDatabaseNames(_a2) {
          var indexedDB2 = _a2.indexedDB, IDBKeyRange = _a2.IDBKeyRange;
          return hasDatabasesNative(indexedDB2) ? Promise.resolve(indexedDB2.databases()).then(function(infos) {
            return infos.map(function(info) {
              return info.name;
            }).filter(function(name) {
              return name !== DBNAMES_DB;
            });
          }) : getDbNamesTable(indexedDB2, IDBKeyRange).toCollection().primaryKeys();
        }
        __name(getDatabaseNames, "getDatabaseNames");
        function _onDatabaseCreated(_a2, name) {
          var indexedDB2 = _a2.indexedDB, IDBKeyRange = _a2.IDBKeyRange;
          !hasDatabasesNative(indexedDB2) && name !== DBNAMES_DB && getDbNamesTable(indexedDB2, IDBKeyRange).put({ name }).catch(nop);
        }
        __name(_onDatabaseCreated, "_onDatabaseCreated");
        function _onDatabaseDeleted(_a2, name) {
          var indexedDB2 = _a2.indexedDB, IDBKeyRange = _a2.IDBKeyRange;
          !hasDatabasesNative(indexedDB2) && name !== DBNAMES_DB && getDbNamesTable(indexedDB2, IDBKeyRange).delete(name).catch(nop);
        }
        __name(_onDatabaseDeleted, "_onDatabaseDeleted");
        function vip(fn2) {
          return newScope(function() {
            PSD.letThrough = true;
            return fn2();
          });
        }
        __name(vip, "vip");
        function idbReady() {
          var isSafari = !navigator.userAgentData && /Safari\//.test(navigator.userAgent) && !/Chrom(e|ium)\//.test(navigator.userAgent);
          if (!isSafari || !indexedDB.databases)
            return Promise.resolve();
          var intervalId;
          return new Promise(function(resolve) {
            var tryIdb = /* @__PURE__ */ __name(function() {
              return indexedDB.databases().finally(resolve);
            }, "tryIdb");
            intervalId = setInterval(tryIdb, 100);
            tryIdb();
          }).finally(function() {
            return clearInterval(intervalId);
          });
        }
        __name(idbReady, "idbReady");
        var _a;
        function isEmptyRange(node) {
          return !("from" in node);
        }
        __name(isEmptyRange, "isEmptyRange");
        var RangeSet2 = /* @__PURE__ */ __name(function(fromOrTree, to) {
          if (this) {
            extend(this, arguments.length ? { d: 1, from: fromOrTree, to: arguments.length > 1 ? to : fromOrTree } : { d: 0 });
          } else {
            var rv = new RangeSet2();
            if (fromOrTree && "d" in fromOrTree) {
              extend(rv, fromOrTree);
            }
            return rv;
          }
        }, "RangeSet");
        props(RangeSet2.prototype, (_a = {
          add: /* @__PURE__ */ __name(function(rangeSet) {
            mergeRanges2(this, rangeSet);
            return this;
          }, "add"),
          addKey: /* @__PURE__ */ __name(function(key2) {
            addRange(this, key2, key2);
            return this;
          }, "addKey"),
          addKeys: /* @__PURE__ */ __name(function(keys2) {
            var _this = this;
            keys2.forEach(function(key2) {
              return addRange(_this, key2, key2);
            });
            return this;
          }, "addKeys"),
          hasKey: /* @__PURE__ */ __name(function(key2) {
            var node = getRangeSetIterator(this).next(key2).value;
            return node && cmp2(node.from, key2) <= 0 && cmp2(node.to, key2) >= 0;
          }, "hasKey")
        }, _a[iteratorSymbol] = function() {
          return getRangeSetIterator(this);
        }, _a));
        function addRange(target, from, to) {
          var diff = cmp2(from, to);
          if (isNaN(diff))
            return;
          if (diff > 0)
            throw RangeError();
          if (isEmptyRange(target))
            return extend(target, { from, to, d: 1 });
          var left = target.l;
          var right = target.r;
          if (cmp2(to, target.from) < 0) {
            left ? addRange(left, from, to) : target.l = { from, to, d: 1, l: null, r: null };
            return rebalance(target);
          }
          if (cmp2(from, target.to) > 0) {
            right ? addRange(right, from, to) : target.r = { from, to, d: 1, l: null, r: null };
            return rebalance(target);
          }
          if (cmp2(from, target.from) < 0) {
            target.from = from;
            target.l = null;
            target.d = right ? right.d + 1 : 1;
          }
          if (cmp2(to, target.to) > 0) {
            target.to = to;
            target.r = null;
            target.d = target.l ? target.l.d + 1 : 1;
          }
          var rightWasCutOff = !target.r;
          if (left && !target.l) {
            mergeRanges2(target, left);
          }
          if (right && rightWasCutOff) {
            mergeRanges2(target, right);
          }
        }
        __name(addRange, "addRange");
        function mergeRanges2(target, newSet) {
          function _addRangeSet(target2, _a2) {
            var from = _a2.from, to = _a2.to, l3 = _a2.l, r3 = _a2.r;
            addRange(target2, from, to);
            if (l3)
              _addRangeSet(target2, l3);
            if (r3)
              _addRangeSet(target2, r3);
          }
          __name(_addRangeSet, "_addRangeSet");
          if (!isEmptyRange(newSet))
            _addRangeSet(target, newSet);
        }
        __name(mergeRanges2, "mergeRanges");
        function rangesOverlap2(rangeSet1, rangeSet2) {
          var i1 = getRangeSetIterator(rangeSet2);
          var nextResult1 = i1.next();
          if (nextResult1.done)
            return false;
          var a3 = nextResult1.value;
          var i22 = getRangeSetIterator(rangeSet1);
          var nextResult2 = i22.next(a3.from);
          var b2 = nextResult2.value;
          while (!nextResult1.done && !nextResult2.done) {
            if (cmp2(b2.from, a3.to) <= 0 && cmp2(b2.to, a3.from) >= 0)
              return true;
            cmp2(a3.from, b2.from) < 0 ? a3 = (nextResult1 = i1.next(b2.from)).value : b2 = (nextResult2 = i22.next(a3.from)).value;
          }
          return false;
        }
        __name(rangesOverlap2, "rangesOverlap");
        function getRangeSetIterator(node) {
          var state = isEmptyRange(node) ? null : { s: 0, n: node };
          return {
            next: /* @__PURE__ */ __name(function(key2) {
              var keyProvided = arguments.length > 0;
              while (state) {
                switch (state.s) {
                  case 0:
                    state.s = 1;
                    if (keyProvided) {
                      while (state.n.l && cmp2(key2, state.n.from) < 0)
                        state = { up: state, n: state.n.l, s: 1 };
                    } else {
                      while (state.n.l)
                        state = { up: state, n: state.n.l, s: 1 };
                    }
                  case 1:
                    state.s = 2;
                    if (!keyProvided || cmp2(key2, state.n.to) <= 0)
                      return { value: state.n, done: false };
                  case 2:
                    if (state.n.r) {
                      state.s = 3;
                      state = { up: state, n: state.n.r, s: 0 };
                      continue;
                    }
                  case 3:
                    state = state.up;
                }
              }
              return { done: true };
            }, "next")
          };
        }
        __name(getRangeSetIterator, "getRangeSetIterator");
        function rebalance(target) {
          var _a2, _b;
          var diff = (((_a2 = target.r) === null || _a2 === void 0 ? void 0 : _a2.d) || 0) - (((_b = target.l) === null || _b === void 0 ? void 0 : _b.d) || 0);
          var r3 = diff > 1 ? "r" : diff < -1 ? "l" : "";
          if (r3) {
            var l3 = r3 === "r" ? "l" : "r";
            var rootClone = __assign({}, target);
            var oldRootRight = target[r3];
            target.from = oldRootRight.from;
            target.to = oldRootRight.to;
            target[r3] = oldRootRight[r3];
            rootClone[r3] = oldRootRight[l3];
            target[l3] = rootClone;
            rootClone.d = computeDepth(rootClone);
          }
          target.d = computeDepth(target);
        }
        __name(rebalance, "rebalance");
        function computeDepth(_a2) {
          var r3 = _a2.r, l3 = _a2.l;
          return (r3 ? l3 ? Math.max(r3.d, l3.d) : r3.d : l3 ? l3.d : 0) + 1;
        }
        __name(computeDepth, "computeDepth");
        function extendObservabilitySet(target, newSet) {
          keys(newSet).forEach(function(part) {
            if (target[part])
              mergeRanges2(target[part], newSet[part]);
            else
              target[part] = cloneSimpleObjectTree(newSet[part]);
          });
          return target;
        }
        __name(extendObservabilitySet, "extendObservabilitySet");
        function obsSetsOverlap(os1, os2) {
          return os1.all || os2.all || Object.keys(os1).some(function(key2) {
            return os2[key2] && rangesOverlap2(os2[key2], os1[key2]);
          });
        }
        __name(obsSetsOverlap, "obsSetsOverlap");
        var cache = {};
        var unsignaledParts = {};
        var isTaskEnqueued = false;
        function signalSubscribersLazily(part, optimistic) {
          extendObservabilitySet(unsignaledParts, part);
          if (!isTaskEnqueued) {
            isTaskEnqueued = true;
            setTimeout(function() {
              isTaskEnqueued = false;
              var parts = unsignaledParts;
              unsignaledParts = {};
              signalSubscribersNow(parts, false);
            }, 0);
          }
        }
        __name(signalSubscribersLazily, "signalSubscribersLazily");
        function signalSubscribersNow(updatedParts, deleteAffectedCacheEntries) {
          if (deleteAffectedCacheEntries === void 0) {
            deleteAffectedCacheEntries = false;
          }
          var queriesToSignal = /* @__PURE__ */ new Set();
          if (updatedParts.all) {
            for (var _i = 0, _a2 = Object.values(cache); _i < _a2.length; _i++) {
              var tblCache = _a2[_i];
              collectTableSubscribers(tblCache, updatedParts, queriesToSignal, deleteAffectedCacheEntries);
            }
          } else {
            for (var key2 in updatedParts) {
              var parts = /^idb\:\/\/(.*)\/(.*)\//.exec(key2);
              if (parts) {
                var dbName = parts[1], tableName = parts[2];
                var tblCache = cache["idb://".concat(dbName, "/").concat(tableName)];
                if (tblCache)
                  collectTableSubscribers(tblCache, updatedParts, queriesToSignal, deleteAffectedCacheEntries);
              }
            }
          }
          queriesToSignal.forEach(function(requery) {
            return requery();
          });
        }
        __name(signalSubscribersNow, "signalSubscribersNow");
        function collectTableSubscribers(tblCache, updatedParts, outQueriesToSignal, deleteAffectedCacheEntries) {
          var updatedEntryLists = [];
          for (var _i = 0, _a2 = Object.entries(tblCache.queries.query); _i < _a2.length; _i++) {
            var _b = _a2[_i], indexName = _b[0], entries = _b[1];
            var filteredEntries = [];
            for (var _c = 0, entries_1 = entries; _c < entries_1.length; _c++) {
              var entry = entries_1[_c];
              if (obsSetsOverlap(updatedParts, entry.obsSet)) {
                entry.subscribers.forEach(function(requery) {
                  return outQueriesToSignal.add(requery);
                });
              } else if (deleteAffectedCacheEntries) {
                filteredEntries.push(entry);
              }
            }
            if (deleteAffectedCacheEntries)
              updatedEntryLists.push([indexName, filteredEntries]);
          }
          if (deleteAffectedCacheEntries) {
            for (var _d = 0, updatedEntryLists_1 = updatedEntryLists; _d < updatedEntryLists_1.length; _d++) {
              var _e = updatedEntryLists_1[_d], indexName = _e[0], filteredEntries = _e[1];
              tblCache.queries.query[indexName] = filteredEntries;
            }
          }
        }
        __name(collectTableSubscribers, "collectTableSubscribers");
        function dexieOpen(db) {
          var state = db._state;
          var indexedDB2 = db._deps.indexedDB;
          if (state.isBeingOpened || db.idbdb)
            return state.dbReadyPromise.then(function() {
              return state.dbOpenError ? rejection(state.dbOpenError) : db;
            });
          state.isBeingOpened = true;
          state.dbOpenError = null;
          state.openComplete = false;
          var openCanceller = state.openCanceller;
          var nativeVerToOpen = Math.round(db.verno * 10);
          var schemaPatchMode = false;
          function throwIfCancelled() {
            if (state.openCanceller !== openCanceller)
              throw new exceptions.DatabaseClosed("db.open() was cancelled");
          }
          __name(throwIfCancelled, "throwIfCancelled");
          var resolveDbReady = state.dbReadyResolve, upgradeTransaction = null, wasCreated = false;
          var tryOpenDB = /* @__PURE__ */ __name(function() {
            return new DexiePromise(function(resolve, reject) {
              throwIfCancelled();
              if (!indexedDB2)
                throw new exceptions.MissingAPI();
              var dbName = db.name;
              var req = state.autoSchema || !nativeVerToOpen ? indexedDB2.open(dbName) : indexedDB2.open(dbName, nativeVerToOpen);
              if (!req)
                throw new exceptions.MissingAPI();
              req.onerror = eventRejectHandler(reject);
              req.onblocked = wrap2(db._fireOnBlocked);
              req.onupgradeneeded = wrap2(function(e3) {
                upgradeTransaction = req.transaction;
                if (state.autoSchema && !db._options.allowEmptyDB) {
                  req.onerror = preventDefault2;
                  upgradeTransaction.abort();
                  req.result.close();
                  var delreq = indexedDB2.deleteDatabase(dbName);
                  delreq.onsuccess = delreq.onerror = wrap2(function() {
                    reject(new exceptions.NoSuchDatabase("Database ".concat(dbName, " doesnt exist")));
                  });
                } else {
                  upgradeTransaction.onerror = eventRejectHandler(reject);
                  var oldVer = e3.oldVersion > Math.pow(2, 62) ? 0 : e3.oldVersion;
                  wasCreated = oldVer < 1;
                  db.idbdb = req.result;
                  if (schemaPatchMode) {
                    patchCurrentVersion(db, upgradeTransaction);
                  }
                  runUpgraders(db, oldVer / 10, upgradeTransaction, reject);
                }
              }, reject);
              req.onsuccess = wrap2(function() {
                upgradeTransaction = null;
                var idbdb = db.idbdb = req.result;
                var objectStoreNames = slice(idbdb.objectStoreNames);
                if (objectStoreNames.length > 0)
                  try {
                    var tmpTrans = idbdb.transaction(safariMultiStoreFix(objectStoreNames), "readonly");
                    if (state.autoSchema)
                      readGlobalSchema(db, idbdb, tmpTrans);
                    else {
                      adjustToExistingIndexNames(db, db._dbSchema, tmpTrans);
                      if (!verifyInstalledSchema(db, tmpTrans) && !schemaPatchMode) {
                        console.warn("Dexie SchemaDiff: Schema was extended without increasing the number passed to db.version(). Dexie will add missing parts and increment native version number to workaround this.");
                        idbdb.close();
                        nativeVerToOpen = idbdb.version + 1;
                        schemaPatchMode = true;
                        return resolve(tryOpenDB());
                      }
                    }
                    generateMiddlewareStacks(db, tmpTrans);
                  } catch (e3) {
                  }
                connections.push(db);
                idbdb.onversionchange = wrap2(function(ev) {
                  state.vcFired = true;
                  db.on("versionchange").fire(ev);
                });
                idbdb.onclose = wrap2(function(ev) {
                  db.on("close").fire(ev);
                });
                if (wasCreated)
                  _onDatabaseCreated(db._deps, dbName);
                resolve();
              }, reject);
            }).catch(function(err) {
              switch (err === null || err === void 0 ? void 0 : err.name) {
                case "UnknownError":
                  if (state.PR1398_maxLoop > 0) {
                    state.PR1398_maxLoop--;
                    console.warn("Dexie: Workaround for Chrome UnknownError on open()");
                    return tryOpenDB();
                  }
                  break;
                case "VersionError":
                  if (nativeVerToOpen > 0) {
                    nativeVerToOpen = 0;
                    return tryOpenDB();
                  }
                  break;
              }
              return DexiePromise.reject(err);
            });
          }, "tryOpenDB");
          return DexiePromise.race([
            openCanceller,
            (typeof navigator === "undefined" ? DexiePromise.resolve() : idbReady()).then(tryOpenDB)
          ]).then(function() {
            throwIfCancelled();
            state.onReadyBeingFired = [];
            return DexiePromise.resolve(vip(function() {
              return db.on.ready.fire(db.vip);
            })).then(/* @__PURE__ */ __name(function fireRemainders() {
              if (state.onReadyBeingFired.length > 0) {
                var remainders_1 = state.onReadyBeingFired.reduce(promisableChain, nop);
                state.onReadyBeingFired = [];
                return DexiePromise.resolve(vip(function() {
                  return remainders_1(db.vip);
                })).then(fireRemainders);
              }
            }, "fireRemainders"));
          }).finally(function() {
            if (state.openCanceller === openCanceller) {
              state.onReadyBeingFired = null;
              state.isBeingOpened = false;
            }
          }).catch(function(err) {
            state.dbOpenError = err;
            try {
              upgradeTransaction && upgradeTransaction.abort();
            } catch (_a2) {
            }
            if (openCanceller === state.openCanceller) {
              db._close();
            }
            return rejection(err);
          }).finally(function() {
            state.openComplete = true;
            resolveDbReady();
          }).then(function() {
            if (wasCreated) {
              var everything_1 = {};
              db.tables.forEach(function(table) {
                table.schema.indexes.forEach(function(idx) {
                  if (idx.name)
                    everything_1["idb://".concat(db.name, "/").concat(table.name, "/").concat(idx.name)] = new RangeSet2(-Infinity, [[[]]]);
                });
                everything_1["idb://".concat(db.name, "/").concat(table.name, "/")] = everything_1["idb://".concat(db.name, "/").concat(table.name, "/:dels")] = new RangeSet2(-Infinity, [[[]]]);
              });
              globalEvents(DEXIE_STORAGE_MUTATED_EVENT_NAME).fire(everything_1);
              signalSubscribersNow(everything_1, true);
            }
            return db;
          });
        }
        __name(dexieOpen, "dexieOpen");
        function awaitIterator(iterator) {
          var callNext = /* @__PURE__ */ __name(function(result) {
            return iterator.next(result);
          }, "callNext"), doThrow = /* @__PURE__ */ __name(function(error) {
            return iterator.throw(error);
          }, "doThrow"), onSuccess = step(callNext), onError = step(doThrow);
          function step(getNext) {
            return function(val) {
              var next = getNext(val), value = next.value;
              return next.done ? value : !value || typeof value.then !== "function" ? isArray(value) ? Promise.all(value).then(onSuccess, onError) : onSuccess(value) : value.then(onSuccess, onError);
            };
          }
          __name(step, "step");
          return step(callNext)();
        }
        __name(awaitIterator, "awaitIterator");
        function extractTransactionArgs(mode, _tableArgs_, scopeFunc) {
          var i3 = arguments.length;
          if (i3 < 2)
            throw new exceptions.InvalidArgument("Too few arguments");
          var args = new Array(i3 - 1);
          while (--i3)
            args[i3 - 1] = arguments[i3];
          scopeFunc = args.pop();
          var tables = flatten(args);
          return [mode, tables, scopeFunc];
        }
        __name(extractTransactionArgs, "extractTransactionArgs");
        function enterTransactionScope(db, mode, storeNames, parentTransaction, scopeFunc) {
          return DexiePromise.resolve().then(function() {
            var transless = PSD.transless || PSD;
            var trans = db._createTransaction(mode, storeNames, db._dbSchema, parentTransaction);
            trans.explicit = true;
            var zoneProps = {
              trans,
              transless
            };
            if (parentTransaction) {
              trans.idbtrans = parentTransaction.idbtrans;
            } else {
              try {
                trans.create();
                trans.idbtrans._explicit = true;
                db._state.PR1398_maxLoop = 3;
              } catch (ex) {
                if (ex.name === errnames.InvalidState && db.isOpen() && --db._state.PR1398_maxLoop > 0) {
                  console.warn("Dexie: Need to reopen db");
                  db.close({ disableAutoOpen: false });
                  return db.open().then(function() {
                    return enterTransactionScope(db, mode, storeNames, null, scopeFunc);
                  });
                }
                return rejection(ex);
              }
            }
            var scopeFuncIsAsync = isAsyncFunction(scopeFunc);
            if (scopeFuncIsAsync) {
              incrementExpectedAwaits();
            }
            var returnValue;
            var promiseFollowed = DexiePromise.follow(function() {
              returnValue = scopeFunc.call(trans, trans);
              if (returnValue) {
                if (scopeFuncIsAsync) {
                  var decrementor = decrementExpectedAwaits.bind(null, null);
                  returnValue.then(decrementor, decrementor);
                } else if (typeof returnValue.next === "function" && typeof returnValue.throw === "function") {
                  returnValue = awaitIterator(returnValue);
                }
              }
            }, zoneProps);
            return (returnValue && typeof returnValue.then === "function" ? DexiePromise.resolve(returnValue).then(function(x4) {
              return trans.active ? x4 : rejection(new exceptions.PrematureCommit("Transaction committed too early. See http://bit.ly/2kdckMn"));
            }) : promiseFollowed.then(function() {
              return returnValue;
            })).then(function(x4) {
              if (parentTransaction)
                trans._resolve();
              return trans._completion.then(function() {
                return x4;
              });
            }).catch(function(e3) {
              trans._reject(e3);
              return rejection(e3);
            });
          });
        }
        __name(enterTransactionScope, "enterTransactionScope");
        function pad(a3, value, count) {
          var result = isArray(a3) ? a3.slice() : [a3];
          for (var i3 = 0; i3 < count; ++i3)
            result.push(value);
          return result;
        }
        __name(pad, "pad");
        function createVirtualIndexMiddleware(down) {
          return __assign(__assign({}, down), { table: /* @__PURE__ */ __name(function(tableName) {
            var table = down.table(tableName);
            var schema = table.schema;
            var indexLookup = {};
            var allVirtualIndexes = [];
            function addVirtualIndexes(keyPath, keyTail, lowLevelIndex) {
              var keyPathAlias = getKeyPathAlias(keyPath);
              var indexList = indexLookup[keyPathAlias] = indexLookup[keyPathAlias] || [];
              var keyLength = keyPath == null ? 0 : typeof keyPath === "string" ? 1 : keyPath.length;
              var isVirtual = keyTail > 0;
              var virtualIndex = __assign(__assign({}, lowLevelIndex), { name: isVirtual ? "".concat(keyPathAlias, "(virtual-from:").concat(lowLevelIndex.name, ")") : lowLevelIndex.name, lowLevelIndex, isVirtual, keyTail, keyLength, extractKey: getKeyExtractor(keyPath), unique: !isVirtual && lowLevelIndex.unique });
              indexList.push(virtualIndex);
              if (!virtualIndex.isPrimaryKey) {
                allVirtualIndexes.push(virtualIndex);
              }
              if (keyLength > 1) {
                var virtualKeyPath = keyLength === 2 ? keyPath[0] : keyPath.slice(0, keyLength - 1);
                addVirtualIndexes(virtualKeyPath, keyTail + 1, lowLevelIndex);
              }
              indexList.sort(function(a3, b2) {
                return a3.keyTail - b2.keyTail;
              });
              return virtualIndex;
            }
            __name(addVirtualIndexes, "addVirtualIndexes");
            var primaryKey = addVirtualIndexes(schema.primaryKey.keyPath, 0, schema.primaryKey);
            indexLookup[":id"] = [primaryKey];
            for (var _i = 0, _a2 = schema.indexes; _i < _a2.length; _i++) {
              var index = _a2[_i];
              addVirtualIndexes(index.keyPath, 0, index);
            }
            function findBestIndex(keyPath) {
              var result2 = indexLookup[getKeyPathAlias(keyPath)];
              return result2 && result2[0];
            }
            __name(findBestIndex, "findBestIndex");
            function translateRange(range, keyTail) {
              return {
                type: range.type === 1 ? 2 : range.type,
                lower: pad(range.lower, range.lowerOpen ? down.MAX_KEY : down.MIN_KEY, keyTail),
                lowerOpen: true,
                upper: pad(range.upper, range.upperOpen ? down.MIN_KEY : down.MAX_KEY, keyTail),
                upperOpen: true
              };
            }
            __name(translateRange, "translateRange");
            function translateRequest(req) {
              var index2 = req.query.index;
              return index2.isVirtual ? __assign(__assign({}, req), { query: {
                index: index2.lowLevelIndex,
                range: translateRange(req.query.range, index2.keyTail)
              } }) : req;
            }
            __name(translateRequest, "translateRequest");
            var result = __assign(__assign({}, table), { schema: __assign(__assign({}, schema), { primaryKey, indexes: allVirtualIndexes, getIndexByKeyPath: findBestIndex }), count: /* @__PURE__ */ __name(function(req) {
              return table.count(translateRequest(req));
            }, "count"), query: /* @__PURE__ */ __name(function(req) {
              return table.query(translateRequest(req));
            }, "query"), openCursor: /* @__PURE__ */ __name(function(req) {
              var _a3 = req.query.index, keyTail = _a3.keyTail, isVirtual = _a3.isVirtual, keyLength = _a3.keyLength;
              if (!isVirtual)
                return table.openCursor(req);
              function createVirtualCursor(cursor) {
                function _continue(key2) {
                  key2 != null ? cursor.continue(pad(key2, req.reverse ? down.MAX_KEY : down.MIN_KEY, keyTail)) : req.unique ? cursor.continue(cursor.key.slice(0, keyLength).concat(req.reverse ? down.MIN_KEY : down.MAX_KEY, keyTail)) : cursor.continue();
                }
                __name(_continue, "_continue");
                var virtualCursor = Object.create(cursor, {
                  continue: { value: _continue },
                  continuePrimaryKey: {
                    value: /* @__PURE__ */ __name(function(key2, primaryKey2) {
                      cursor.continuePrimaryKey(pad(key2, down.MAX_KEY, keyTail), primaryKey2);
                    }, "value")
                  },
                  primaryKey: {
                    get: /* @__PURE__ */ __name(function() {
                      return cursor.primaryKey;
                    }, "get")
                  },
                  key: {
                    get: /* @__PURE__ */ __name(function() {
                      var key2 = cursor.key;
                      return keyLength === 1 ? key2[0] : key2.slice(0, keyLength);
                    }, "get")
                  },
                  value: {
                    get: /* @__PURE__ */ __name(function() {
                      return cursor.value;
                    }, "get")
                  }
                });
                return virtualCursor;
              }
              __name(createVirtualCursor, "createVirtualCursor");
              return table.openCursor(translateRequest(req)).then(function(cursor) {
                return cursor && createVirtualCursor(cursor);
              });
            }, "openCursor") });
            return result;
          }, "table") });
        }
        __name(createVirtualIndexMiddleware, "createVirtualIndexMiddleware");
        var virtualIndexMiddleware = {
          stack: "dbcore",
          name: "VirtualIndexMiddleware",
          level: 1,
          create: createVirtualIndexMiddleware
        };
        function getObjectDiff(a3, b2, rv, prfx) {
          rv = rv || {};
          prfx = prfx || "";
          keys(a3).forEach(function(prop) {
            if (!hasOwn(b2, prop)) {
              rv[prfx + prop] = void 0;
            } else {
              var ap = a3[prop], bp = b2[prop];
              if (typeof ap === "object" && typeof bp === "object" && ap && bp) {
                var apTypeName = toStringTag(ap);
                var bpTypeName = toStringTag(bp);
                if (apTypeName !== bpTypeName) {
                  rv[prfx + prop] = b2[prop];
                } else if (apTypeName === "Object") {
                  getObjectDiff(ap, bp, rv, prfx + prop + ".");
                } else if (ap !== bp) {
                  rv[prfx + prop] = b2[prop];
                }
              } else if (ap !== bp)
                rv[prfx + prop] = b2[prop];
            }
          });
          keys(b2).forEach(function(prop) {
            if (!hasOwn(a3, prop)) {
              rv[prfx + prop] = b2[prop];
            }
          });
          return rv;
        }
        __name(getObjectDiff, "getObjectDiff");
        function getEffectiveKeys(primaryKey, req) {
          if (req.type === "delete")
            return req.keys;
          return req.keys || req.values.map(primaryKey.extractKey);
        }
        __name(getEffectiveKeys, "getEffectiveKeys");
        var hooksMiddleware = {
          stack: "dbcore",
          name: "HooksMiddleware",
          level: 2,
          create: /* @__PURE__ */ __name(function(downCore) {
            return __assign(__assign({}, downCore), { table: /* @__PURE__ */ __name(function(tableName) {
              var downTable = downCore.table(tableName);
              var primaryKey = downTable.schema.primaryKey;
              var tableMiddleware = __assign(__assign({}, downTable), { mutate: /* @__PURE__ */ __name(function(req) {
                var dxTrans = PSD.trans;
                var _a2 = dxTrans.table(tableName).hook, deleting = _a2.deleting, creating = _a2.creating, updating = _a2.updating;
                switch (req.type) {
                  case "add":
                    if (creating.fire === nop)
                      break;
                    return dxTrans._promise("readwrite", function() {
                      return addPutOrDelete(req);
                    }, true);
                  case "put":
                    if (creating.fire === nop && updating.fire === nop)
                      break;
                    return dxTrans._promise("readwrite", function() {
                      return addPutOrDelete(req);
                    }, true);
                  case "delete":
                    if (deleting.fire === nop)
                      break;
                    return dxTrans._promise("readwrite", function() {
                      return addPutOrDelete(req);
                    }, true);
                  case "deleteRange":
                    if (deleting.fire === nop)
                      break;
                    return dxTrans._promise("readwrite", function() {
                      return deleteRange(req);
                    }, true);
                }
                return downTable.mutate(req);
                function addPutOrDelete(req2) {
                  var dxTrans2 = PSD.trans;
                  var keys2 = req2.keys || getEffectiveKeys(primaryKey, req2);
                  if (!keys2)
                    throw new Error("Keys missing");
                  req2 = req2.type === "add" || req2.type === "put" ? __assign(__assign({}, req2), { keys: keys2 }) : __assign({}, req2);
                  if (req2.type !== "delete")
                    req2.values = __spreadArray([], req2.values, true);
                  if (req2.keys)
                    req2.keys = __spreadArray([], req2.keys, true);
                  return getExistingValues(downTable, req2, keys2).then(function(existingValues) {
                    var contexts = keys2.map(function(key2, i3) {
                      var existingValue = existingValues[i3];
                      var ctx = { onerror: null, onsuccess: null };
                      if (req2.type === "delete") {
                        deleting.fire.call(ctx, key2, existingValue, dxTrans2);
                      } else if (req2.type === "add" || existingValue === void 0) {
                        var generatedPrimaryKey = creating.fire.call(ctx, key2, req2.values[i3], dxTrans2);
                        if (key2 == null && generatedPrimaryKey != null) {
                          key2 = generatedPrimaryKey;
                          req2.keys[i3] = key2;
                          if (!primaryKey.outbound) {
                            setByKeyPath(req2.values[i3], primaryKey.keyPath, key2);
                          }
                        }
                      } else {
                        var objectDiff = getObjectDiff(existingValue, req2.values[i3]);
                        var additionalChanges_1 = updating.fire.call(ctx, objectDiff, key2, existingValue, dxTrans2);
                        if (additionalChanges_1) {
                          var requestedValue_1 = req2.values[i3];
                          Object.keys(additionalChanges_1).forEach(function(keyPath) {
                            if (hasOwn(requestedValue_1, keyPath)) {
                              requestedValue_1[keyPath] = additionalChanges_1[keyPath];
                            } else {
                              setByKeyPath(requestedValue_1, keyPath, additionalChanges_1[keyPath]);
                            }
                          });
                        }
                      }
                      return ctx;
                    });
                    return downTable.mutate(req2).then(function(_a3) {
                      var failures = _a3.failures, results = _a3.results, numFailures = _a3.numFailures, lastResult = _a3.lastResult;
                      for (var i3 = 0; i3 < keys2.length; ++i3) {
                        var primKey = results ? results[i3] : keys2[i3];
                        var ctx = contexts[i3];
                        if (primKey == null) {
                          ctx.onerror && ctx.onerror(failures[i3]);
                        } else {
                          ctx.onsuccess && ctx.onsuccess(
                            req2.type === "put" && existingValues[i3] ? req2.values[i3] : primKey
                          );
                        }
                      }
                      return { failures, results, numFailures, lastResult };
                    }).catch(function(error) {
                      contexts.forEach(function(ctx) {
                        return ctx.onerror && ctx.onerror(error);
                      });
                      return Promise.reject(error);
                    });
                  });
                }
                __name(addPutOrDelete, "addPutOrDelete");
                function deleteRange(req2) {
                  return deleteNextChunk(req2.trans, req2.range, 1e4);
                }
                __name(deleteRange, "deleteRange");
                function deleteNextChunk(trans, range, limit) {
                  return downTable.query({ trans, values: false, query: { index: primaryKey, range }, limit }).then(function(_a3) {
                    var result = _a3.result;
                    return addPutOrDelete({ type: "delete", keys: result, trans }).then(function(res) {
                      if (res.numFailures > 0)
                        return Promise.reject(res.failures[0]);
                      if (result.length < limit) {
                        return { failures: [], numFailures: 0, lastResult: void 0 };
                      } else {
                        return deleteNextChunk(trans, __assign(__assign({}, range), { lower: result[result.length - 1], lowerOpen: true }), limit);
                      }
                    });
                  });
                }
                __name(deleteNextChunk, "deleteNextChunk");
              }, "mutate") });
              return tableMiddleware;
            }, "table") });
          }, "create")
        };
        function getExistingValues(table, req, effectiveKeys) {
          return req.type === "add" ? Promise.resolve([]) : table.getMany({ trans: req.trans, keys: effectiveKeys, cache: "immutable" });
        }
        __name(getExistingValues, "getExistingValues");
        function getFromTransactionCache(keys2, cache2, clone) {
          try {
            if (!cache2)
              return null;
            if (cache2.keys.length < keys2.length)
              return null;
            var result = [];
            for (var i3 = 0, j4 = 0; i3 < cache2.keys.length && j4 < keys2.length; ++i3) {
              if (cmp2(cache2.keys[i3], keys2[j4]) !== 0)
                continue;
              result.push(clone ? deepClone(cache2.values[i3]) : cache2.values[i3]);
              ++j4;
            }
            return result.length === keys2.length ? result : null;
          } catch (_a2) {
            return null;
          }
        }
        __name(getFromTransactionCache, "getFromTransactionCache");
        var cacheExistingValuesMiddleware = {
          stack: "dbcore",
          level: -1,
          create: /* @__PURE__ */ __name(function(core) {
            return {
              table: /* @__PURE__ */ __name(function(tableName) {
                var table = core.table(tableName);
                return __assign(__assign({}, table), { getMany: /* @__PURE__ */ __name(function(req) {
                  if (!req.cache) {
                    return table.getMany(req);
                  }
                  var cachedResult = getFromTransactionCache(req.keys, req.trans["_cache"], req.cache === "clone");
                  if (cachedResult) {
                    return DexiePromise.resolve(cachedResult);
                  }
                  return table.getMany(req).then(function(res) {
                    req.trans["_cache"] = {
                      keys: req.keys,
                      values: req.cache === "clone" ? deepClone(res) : res
                    };
                    return res;
                  });
                }, "getMany"), mutate: /* @__PURE__ */ __name(function(req) {
                  if (req.type !== "add")
                    req.trans["_cache"] = null;
                  return table.mutate(req);
                }, "mutate") });
              }, "table")
            };
          }, "create")
        };
        function isCachableContext(ctx, table) {
          return ctx.trans.mode === "readonly" && !!ctx.subscr && !ctx.trans.explicit && ctx.trans.db._options.cache !== "disabled" && !table.schema.primaryKey.outbound;
        }
        __name(isCachableContext, "isCachableContext");
        function isCachableRequest(type2, req) {
          switch (type2) {
            case "query":
              return req.values && !req.unique;
            case "get":
              return false;
            case "getMany":
              return false;
            case "count":
              return false;
            case "openCursor":
              return false;
          }
        }
        __name(isCachableRequest, "isCachableRequest");
        var observabilityMiddleware = {
          stack: "dbcore",
          level: 0,
          name: "Observability",
          create: /* @__PURE__ */ __name(function(core) {
            var dbName = core.schema.name;
            var FULL_RANGE = new RangeSet2(core.MIN_KEY, core.MAX_KEY);
            return __assign(__assign({}, core), { transaction: /* @__PURE__ */ __name(function(stores, mode, options2) {
              if (PSD.subscr && mode !== "readonly") {
                throw new exceptions.ReadOnly("Readwrite transaction in liveQuery context. Querier source: ".concat(PSD.querier));
              }
              return core.transaction(stores, mode, options2);
            }, "transaction"), table: /* @__PURE__ */ __name(function(tableName) {
              var table = core.table(tableName);
              var schema = table.schema;
              var primaryKey = schema.primaryKey, indexes = schema.indexes;
              var extractKey = primaryKey.extractKey, outbound = primaryKey.outbound;
              var indexesWithAutoIncPK = primaryKey.autoIncrement && indexes.filter(function(index) {
                return index.compound && index.keyPath.includes(primaryKey.keyPath);
              });
              var tableClone = __assign(__assign({}, table), { mutate: /* @__PURE__ */ __name(function(req) {
                var _a2, _b;
                var trans = req.trans;
                var mutatedParts = req.mutatedParts || (req.mutatedParts = {});
                var getRangeSet = /* @__PURE__ */ __name(function(indexName) {
                  var part = "idb://".concat(dbName, "/").concat(tableName, "/").concat(indexName);
                  return mutatedParts[part] || (mutatedParts[part] = new RangeSet2());
                }, "getRangeSet");
                var pkRangeSet = getRangeSet("");
                var delsRangeSet = getRangeSet(":dels");
                var type2 = req.type;
                var _c = req.type === "deleteRange" ? [req.range] : req.type === "delete" ? [req.keys] : req.values.length < 50 ? [getEffectiveKeys(primaryKey, req).filter(function(id) {
                  return id;
                }), req.values] : [], keys2 = _c[0], newObjs = _c[1];
                var oldCache = req.trans["_cache"];
                if (isArray(keys2)) {
                  pkRangeSet.addKeys(keys2);
                  var oldObjs = type2 === "delete" || keys2.length === newObjs.length ? getFromTransactionCache(keys2, oldCache) : null;
                  if (!oldObjs) {
                    delsRangeSet.addKeys(keys2);
                  }
                  if (oldObjs || newObjs) {
                    trackAffectedIndexes(getRangeSet, schema, oldObjs, newObjs);
                  }
                } else if (keys2) {
                  var range = {
                    from: (_a2 = keys2.lower) !== null && _a2 !== void 0 ? _a2 : core.MIN_KEY,
                    to: (_b = keys2.upper) !== null && _b !== void 0 ? _b : core.MAX_KEY
                  };
                  delsRangeSet.add(range);
                  pkRangeSet.add(range);
                } else {
                  pkRangeSet.add(FULL_RANGE);
                  delsRangeSet.add(FULL_RANGE);
                  schema.indexes.forEach(function(idx) {
                    return getRangeSet(idx.name).add(FULL_RANGE);
                  });
                }
                return table.mutate(req).then(function(res) {
                  if (keys2 && (req.type === "add" || req.type === "put")) {
                    pkRangeSet.addKeys(res.results);
                    if (indexesWithAutoIncPK) {
                      indexesWithAutoIncPK.forEach(function(idx) {
                        var idxVals = req.values.map(function(v3) {
                          return idx.extractKey(v3);
                        });
                        var pkPos = idx.keyPath.findIndex(function(prop) {
                          return prop === primaryKey.keyPath;
                        });
                        for (var i3 = 0, len = res.results.length; i3 < len; ++i3) {
                          idxVals[i3][pkPos] = res.results[i3];
                        }
                        getRangeSet(idx.name).addKeys(idxVals);
                      });
                    }
                  }
                  trans.mutatedParts = extendObservabilitySet(trans.mutatedParts || {}, mutatedParts);
                  return res;
                });
              }, "mutate") });
              var getRange = /* @__PURE__ */ __name(function(_a2) {
                var _b, _c;
                var _d = _a2.query, index = _d.index, range = _d.range;
                return [
                  index,
                  new RangeSet2((_b = range.lower) !== null && _b !== void 0 ? _b : core.MIN_KEY, (_c = range.upper) !== null && _c !== void 0 ? _c : core.MAX_KEY)
                ];
              }, "getRange");
              var readSubscribers = {
                get: /* @__PURE__ */ __name(function(req) {
                  return [primaryKey, new RangeSet2(req.key)];
                }, "get"),
                getMany: /* @__PURE__ */ __name(function(req) {
                  return [primaryKey, new RangeSet2().addKeys(req.keys)];
                }, "getMany"),
                count: getRange,
                query: getRange,
                openCursor: getRange
              };
              keys(readSubscribers).forEach(function(method) {
                tableClone[method] = function(req) {
                  var subscr = PSD.subscr;
                  var isLiveQuery = !!subscr;
                  var cachable = isCachableContext(PSD, table) && isCachableRequest(method, req);
                  var obsSet = cachable ? req.obsSet = {} : subscr;
                  if (isLiveQuery) {
                    var getRangeSet = /* @__PURE__ */ __name(function(indexName) {
                      var part = "idb://".concat(dbName, "/").concat(tableName, "/").concat(indexName);
                      return obsSet[part] || (obsSet[part] = new RangeSet2());
                    }, "getRangeSet");
                    var pkRangeSet_1 = getRangeSet("");
                    var delsRangeSet_1 = getRangeSet(":dels");
                    var _a2 = readSubscribers[method](req), queriedIndex = _a2[0], queriedRanges = _a2[1];
                    if (method === "query" && queriedIndex.isPrimaryKey && !req.values) {
                      delsRangeSet_1.add(queriedRanges);
                    } else {
                      getRangeSet(queriedIndex.name || "").add(queriedRanges);
                    }
                    if (!queriedIndex.isPrimaryKey) {
                      if (method === "count") {
                        delsRangeSet_1.add(FULL_RANGE);
                      } else {
                        var keysPromise_1 = method === "query" && outbound && req.values && table.query(__assign(__assign({}, req), { values: false }));
                        return table[method].apply(this, arguments).then(function(res) {
                          if (method === "query") {
                            if (outbound && req.values) {
                              return keysPromise_1.then(function(_a3) {
                                var resultingKeys = _a3.result;
                                pkRangeSet_1.addKeys(resultingKeys);
                                return res;
                              });
                            }
                            var pKeys = req.values ? res.result.map(extractKey) : res.result;
                            if (req.values) {
                              pkRangeSet_1.addKeys(pKeys);
                            } else {
                              delsRangeSet_1.addKeys(pKeys);
                            }
                          } else if (method === "openCursor") {
                            var cursor_1 = res;
                            var wantValues_1 = req.values;
                            return cursor_1 && Object.create(cursor_1, {
                              key: {
                                get: /* @__PURE__ */ __name(function() {
                                  delsRangeSet_1.addKey(cursor_1.primaryKey);
                                  return cursor_1.key;
                                }, "get")
                              },
                              primaryKey: {
                                get: /* @__PURE__ */ __name(function() {
                                  var pkey = cursor_1.primaryKey;
                                  delsRangeSet_1.addKey(pkey);
                                  return pkey;
                                }, "get")
                              },
                              value: {
                                get: /* @__PURE__ */ __name(function() {
                                  wantValues_1 && pkRangeSet_1.addKey(cursor_1.primaryKey);
                                  return cursor_1.value;
                                }, "get")
                              }
                            });
                          }
                          return res;
                        });
                      }
                    }
                  }
                  return table[method].apply(this, arguments);
                };
              });
              return tableClone;
            }, "table") });
          }, "create")
        };
        function trackAffectedIndexes(getRangeSet, schema, oldObjs, newObjs) {
          function addAffectedIndex(ix) {
            var rangeSet = getRangeSet(ix.name || "");
            function extractKey(obj) {
              return obj != null ? ix.extractKey(obj) : null;
            }
            __name(extractKey, "extractKey");
            var addKeyOrKeys = /* @__PURE__ */ __name(function(key2) {
              return ix.multiEntry && isArray(key2) ? key2.forEach(function(key3) {
                return rangeSet.addKey(key3);
              }) : rangeSet.addKey(key2);
            }, "addKeyOrKeys");
            (oldObjs || newObjs).forEach(function(_3, i3) {
              var oldKey = oldObjs && extractKey(oldObjs[i3]);
              var newKey = newObjs && extractKey(newObjs[i3]);
              if (cmp2(oldKey, newKey) !== 0) {
                if (oldKey != null)
                  addKeyOrKeys(oldKey);
                if (newKey != null)
                  addKeyOrKeys(newKey);
              }
            });
          }
          __name(addAffectedIndex, "addAffectedIndex");
          schema.indexes.forEach(addAffectedIndex);
        }
        __name(trackAffectedIndexes, "trackAffectedIndexes");
        function adjustOptimisticFromFailures(tblCache, req, res) {
          if (res.numFailures === 0)
            return req;
          if (req.type === "deleteRange") {
            return null;
          }
          var numBulkOps = req.keys ? req.keys.length : "values" in req && req.values ? req.values.length : 1;
          if (res.numFailures === numBulkOps) {
            return null;
          }
          var clone = __assign({}, req);
          if (isArray(clone.keys)) {
            clone.keys = clone.keys.filter(function(_3, i3) {
              return !(i3 in res.failures);
            });
          }
          if ("values" in clone && isArray(clone.values)) {
            clone.values = clone.values.filter(function(_3, i3) {
              return !(i3 in res.failures);
            });
          }
          return clone;
        }
        __name(adjustOptimisticFromFailures, "adjustOptimisticFromFailures");
        function isAboveLower(key2, range) {
          return range.lower === void 0 ? true : range.lowerOpen ? cmp2(key2, range.lower) > 0 : cmp2(key2, range.lower) >= 0;
        }
        __name(isAboveLower, "isAboveLower");
        function isBelowUpper(key2, range) {
          return range.upper === void 0 ? true : range.upperOpen ? cmp2(key2, range.upper) < 0 : cmp2(key2, range.upper) <= 0;
        }
        __name(isBelowUpper, "isBelowUpper");
        function isWithinRange(key2, range) {
          return isAboveLower(key2, range) && isBelowUpper(key2, range);
        }
        __name(isWithinRange, "isWithinRange");
        function applyOptimisticOps(result, req, ops, table, cacheEntry, immutable) {
          if (!ops || ops.length === 0)
            return result;
          var index = req.query.index;
          var multiEntry = index.multiEntry;
          var queryRange = req.query.range;
          var primaryKey = table.schema.primaryKey;
          var extractPrimKey = primaryKey.extractKey;
          var extractIndex = index.extractKey;
          var extractLowLevelIndex = (index.lowLevelIndex || index).extractKey;
          var finalResult = ops.reduce(function(result2, op) {
            var modifedResult = result2;
            var includedValues = [];
            if (op.type === "add" || op.type === "put") {
              var includedPKs = new RangeSet2();
              for (var i3 = op.values.length - 1; i3 >= 0; --i3) {
                var value = op.values[i3];
                var pk = extractPrimKey(value);
                if (includedPKs.hasKey(pk))
                  continue;
                var key2 = extractIndex(value);
                if (multiEntry && isArray(key2) ? key2.some(function(k4) {
                  return isWithinRange(k4, queryRange);
                }) : isWithinRange(key2, queryRange)) {
                  includedPKs.addKey(pk);
                  includedValues.push(value);
                }
              }
            }
            switch (op.type) {
              case "add": {
                var existingKeys_1 = new RangeSet2().addKeys(req.values ? result2.map(function(v3) {
                  return extractPrimKey(v3);
                }) : result2);
                modifedResult = result2.concat(req.values ? includedValues.filter(function(v3) {
                  var key3 = extractPrimKey(v3);
                  if (existingKeys_1.hasKey(key3))
                    return false;
                  existingKeys_1.addKey(key3);
                  return true;
                }) : includedValues.map(function(v3) {
                  return extractPrimKey(v3);
                }).filter(function(k4) {
                  if (existingKeys_1.hasKey(k4))
                    return false;
                  existingKeys_1.addKey(k4);
                  return true;
                }));
                break;
              }
              case "put": {
                var keySet_1 = new RangeSet2().addKeys(op.values.map(function(v3) {
                  return extractPrimKey(v3);
                }));
                modifedResult = result2.filter(
                  function(item) {
                    return !keySet_1.hasKey(req.values ? extractPrimKey(item) : item);
                  }
                ).concat(
                  req.values ? includedValues : includedValues.map(function(v3) {
                    return extractPrimKey(v3);
                  })
                );
                break;
              }
              case "delete":
                var keysToDelete_1 = new RangeSet2().addKeys(op.keys);
                modifedResult = result2.filter(function(item) {
                  return !keysToDelete_1.hasKey(req.values ? extractPrimKey(item) : item);
                });
                break;
              case "deleteRange":
                var range_1 = op.range;
                modifedResult = result2.filter(function(item) {
                  return !isWithinRange(extractPrimKey(item), range_1);
                });
                break;
            }
            return modifedResult;
          }, result);
          if (finalResult === result)
            return result;
          finalResult.sort(function(a3, b2) {
            return cmp2(extractLowLevelIndex(a3), extractLowLevelIndex(b2)) || cmp2(extractPrimKey(a3), extractPrimKey(b2));
          });
          if (req.limit && req.limit < Infinity) {
            if (finalResult.length > req.limit) {
              finalResult.length = req.limit;
            } else if (result.length === req.limit && finalResult.length < req.limit) {
              cacheEntry.dirty = true;
            }
          }
          return immutable ? Object.freeze(finalResult) : finalResult;
        }
        __name(applyOptimisticOps, "applyOptimisticOps");
        function areRangesEqual(r1, r22) {
          return cmp2(r1.lower, r22.lower) === 0 && cmp2(r1.upper, r22.upper) === 0 && !!r1.lowerOpen === !!r22.lowerOpen && !!r1.upperOpen === !!r22.upperOpen;
        }
        __name(areRangesEqual, "areRangesEqual");
        function compareLowers(lower1, lower2, lowerOpen1, lowerOpen2) {
          if (lower1 === void 0)
            return lower2 !== void 0 ? -1 : 0;
          if (lower2 === void 0)
            return 1;
          var c3 = cmp2(lower1, lower2);
          if (c3 === 0) {
            if (lowerOpen1 && lowerOpen2)
              return 0;
            if (lowerOpen1)
              return 1;
            if (lowerOpen2)
              return -1;
          }
          return c3;
        }
        __name(compareLowers, "compareLowers");
        function compareUppers(upper1, upper2, upperOpen1, upperOpen2) {
          if (upper1 === void 0)
            return upper2 !== void 0 ? 1 : 0;
          if (upper2 === void 0)
            return -1;
          var c3 = cmp2(upper1, upper2);
          if (c3 === 0) {
            if (upperOpen1 && upperOpen2)
              return 0;
            if (upperOpen1)
              return -1;
            if (upperOpen2)
              return 1;
          }
          return c3;
        }
        __name(compareUppers, "compareUppers");
        function isSuperRange(r1, r22) {
          return compareLowers(r1.lower, r22.lower, r1.lowerOpen, r22.lowerOpen) <= 0 && compareUppers(r1.upper, r22.upper, r1.upperOpen, r22.upperOpen) >= 0;
        }
        __name(isSuperRange, "isSuperRange");
        function findCompatibleQuery(dbName, tableName, type2, req) {
          var tblCache = cache["idb://".concat(dbName, "/").concat(tableName)];
          if (!tblCache)
            return [];
          var queries = tblCache.queries[type2];
          if (!queries)
            return [null, false, tblCache, null];
          var indexName = req.query ? req.query.index.name : null;
          var entries = queries[indexName || ""];
          if (!entries)
            return [null, false, tblCache, null];
          switch (type2) {
            case "query":
              var equalEntry = entries.find(function(entry) {
                return entry.req.limit === req.limit && entry.req.values === req.values && areRangesEqual(entry.req.query.range, req.query.range);
              });
              if (equalEntry)
                return [
                  equalEntry,
                  true,
                  tblCache,
                  entries
                ];
              var superEntry = entries.find(function(entry) {
                var limit = "limit" in entry.req ? entry.req.limit : Infinity;
                return limit >= req.limit && (req.values ? entry.req.values : true) && isSuperRange(entry.req.query.range, req.query.range);
              });
              return [superEntry, false, tblCache, entries];
            case "count":
              var countQuery = entries.find(function(entry) {
                return areRangesEqual(entry.req.query.range, req.query.range);
              });
              return [countQuery, !!countQuery, tblCache, entries];
          }
        }
        __name(findCompatibleQuery, "findCompatibleQuery");
        function subscribeToCacheEntry(cacheEntry, container, requery, signal) {
          cacheEntry.subscribers.add(requery);
          signal.addEventListener("abort", function() {
            cacheEntry.subscribers.delete(requery);
            if (cacheEntry.subscribers.size === 0) {
              enqueForDeletion(cacheEntry, container);
            }
          });
        }
        __name(subscribeToCacheEntry, "subscribeToCacheEntry");
        function enqueForDeletion(cacheEntry, container) {
          setTimeout(function() {
            if (cacheEntry.subscribers.size === 0) {
              delArrayItem(container, cacheEntry);
            }
          }, 3e3);
        }
        __name(enqueForDeletion, "enqueForDeletion");
        var cacheMiddleware = {
          stack: "dbcore",
          level: 0,
          name: "Cache",
          create: /* @__PURE__ */ __name(function(core) {
            var dbName = core.schema.name;
            var coreMW = __assign(__assign({}, core), { transaction: /* @__PURE__ */ __name(function(stores, mode, options2) {
              var idbtrans = core.transaction(stores, mode, options2);
              if (mode === "readwrite") {
                var ac_1 = new AbortController();
                var signal = ac_1.signal;
                var endTransaction = /* @__PURE__ */ __name(function(wasCommitted) {
                  return function() {
                    ac_1.abort();
                    if (mode === "readwrite") {
                      var affectedSubscribers_1 = /* @__PURE__ */ new Set();
                      for (var _i = 0, stores_1 = stores; _i < stores_1.length; _i++) {
                        var storeName = stores_1[_i];
                        var tblCache = cache["idb://".concat(dbName, "/").concat(storeName)];
                        if (tblCache) {
                          var table = core.table(storeName);
                          var ops = tblCache.optimisticOps.filter(function(op) {
                            return op.trans === idbtrans;
                          });
                          if (idbtrans._explicit && wasCommitted && idbtrans.mutatedParts) {
                            for (var _a2 = 0, _b = Object.values(tblCache.queries.query); _a2 < _b.length; _a2++) {
                              var entries = _b[_a2];
                              for (var _c = 0, _d = entries.slice(); _c < _d.length; _c++) {
                                var entry = _d[_c];
                                if (obsSetsOverlap(entry.obsSet, idbtrans.mutatedParts)) {
                                  delArrayItem(entries, entry);
                                  entry.subscribers.forEach(function(requery) {
                                    return affectedSubscribers_1.add(requery);
                                  });
                                }
                              }
                            }
                          } else if (ops.length > 0) {
                            tblCache.optimisticOps = tblCache.optimisticOps.filter(function(op) {
                              return op.trans !== idbtrans;
                            });
                            for (var _e = 0, _f = Object.values(tblCache.queries.query); _e < _f.length; _e++) {
                              var entries = _f[_e];
                              for (var _g = 0, _h = entries.slice(); _g < _h.length; _g++) {
                                var entry = _h[_g];
                                if (entry.res != null && idbtrans.mutatedParts) {
                                  if (wasCommitted && !entry.dirty) {
                                    var freezeResults = Object.isFrozen(entry.res);
                                    var modRes = applyOptimisticOps(entry.res, entry.req, ops, table, entry, freezeResults);
                                    if (entry.dirty) {
                                      delArrayItem(entries, entry);
                                      entry.subscribers.forEach(function(requery) {
                                        return affectedSubscribers_1.add(requery);
                                      });
                                    } else if (modRes !== entry.res) {
                                      entry.res = modRes;
                                      entry.promise = DexiePromise.resolve({ result: modRes });
                                    }
                                  } else {
                                    if (entry.dirty) {
                                      delArrayItem(entries, entry);
                                    }
                                    entry.subscribers.forEach(function(requery) {
                                      return affectedSubscribers_1.add(requery);
                                    });
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                      affectedSubscribers_1.forEach(function(requery) {
                        return requery();
                      });
                    }
                  };
                }, "endTransaction");
                idbtrans.addEventListener("abort", endTransaction(false), {
                  signal
                });
                idbtrans.addEventListener("error", endTransaction(false), {
                  signal
                });
                idbtrans.addEventListener("complete", endTransaction(true), {
                  signal
                });
              }
              return idbtrans;
            }, "transaction"), table: /* @__PURE__ */ __name(function(tableName) {
              var downTable = core.table(tableName);
              var primKey = downTable.schema.primaryKey;
              var tableMW = __assign(__assign({}, downTable), { mutate: /* @__PURE__ */ __name(function(req) {
                var trans = PSD.trans;
                if (primKey.outbound || trans.db._options.cache === "disabled" || trans.explicit || trans.idbtrans.mode !== "readwrite") {
                  return downTable.mutate(req);
                }
                var tblCache = cache["idb://".concat(dbName, "/").concat(tableName)];
                if (!tblCache)
                  return downTable.mutate(req);
                var promise = downTable.mutate(req);
                if ((req.type === "add" || req.type === "put") && (req.values.length >= 50 || getEffectiveKeys(primKey, req).some(function(key2) {
                  return key2 == null;
                }))) {
                  promise.then(function(res) {
                    var reqWithResolvedKeys = __assign(__assign({}, req), { values: req.values.map(function(value, i3) {
                      var _a2;
                      if (res.failures[i3])
                        return value;
                      var valueWithKey = ((_a2 = primKey.keyPath) === null || _a2 === void 0 ? void 0 : _a2.includes(".")) ? deepClone(value) : __assign({}, value);
                      setByKeyPath(valueWithKey, primKey.keyPath, res.results[i3]);
                      return valueWithKey;
                    }) });
                    var adjustedReq = adjustOptimisticFromFailures(tblCache, reqWithResolvedKeys, res);
                    tblCache.optimisticOps.push(adjustedReq);
                    queueMicrotask(function() {
                      return req.mutatedParts && signalSubscribersLazily(req.mutatedParts);
                    });
                  });
                } else {
                  tblCache.optimisticOps.push(req);
                  req.mutatedParts && signalSubscribersLazily(req.mutatedParts);
                  promise.then(function(res) {
                    if (res.numFailures > 0) {
                      delArrayItem(tblCache.optimisticOps, req);
                      var adjustedReq = adjustOptimisticFromFailures(tblCache, req, res);
                      if (adjustedReq) {
                        tblCache.optimisticOps.push(adjustedReq);
                      }
                      req.mutatedParts && signalSubscribersLazily(req.mutatedParts);
                    }
                  });
                  promise.catch(function() {
                    delArrayItem(tblCache.optimisticOps, req);
                    req.mutatedParts && signalSubscribersLazily(req.mutatedParts);
                  });
                }
                return promise;
              }, "mutate"), query: /* @__PURE__ */ __name(function(req) {
                var _a2;
                if (!isCachableContext(PSD, downTable) || !isCachableRequest("query", req))
                  return downTable.query(req);
                var freezeResults = ((_a2 = PSD.trans) === null || _a2 === void 0 ? void 0 : _a2.db._options.cache) === "immutable";
                var _b = PSD, requery = _b.requery, signal = _b.signal;
                var _c = findCompatibleQuery(dbName, tableName, "query", req), cacheEntry = _c[0], exactMatch = _c[1], tblCache = _c[2], container = _c[3];
                if (cacheEntry && exactMatch) {
                  cacheEntry.obsSet = req.obsSet;
                } else {
                  var promise = downTable.query(req).then(function(res) {
                    var result = res.result;
                    if (cacheEntry)
                      cacheEntry.res = result;
                    if (freezeResults) {
                      for (var i3 = 0, l3 = result.length; i3 < l3; ++i3) {
                        Object.freeze(result[i3]);
                      }
                      Object.freeze(result);
                    } else {
                      res.result = deepClone(result);
                    }
                    return res;
                  }).catch(function(error) {
                    if (container && cacheEntry)
                      delArrayItem(container, cacheEntry);
                    return Promise.reject(error);
                  });
                  cacheEntry = {
                    obsSet: req.obsSet,
                    promise,
                    subscribers: /* @__PURE__ */ new Set(),
                    type: "query",
                    req,
                    dirty: false
                  };
                  if (container) {
                    container.push(cacheEntry);
                  } else {
                    container = [cacheEntry];
                    if (!tblCache) {
                      tblCache = cache["idb://".concat(dbName, "/").concat(tableName)] = {
                        queries: {
                          query: {},
                          count: {}
                        },
                        objs: /* @__PURE__ */ new Map(),
                        optimisticOps: [],
                        unsignaledParts: {}
                      };
                    }
                    tblCache.queries.query[req.query.index.name || ""] = container;
                  }
                }
                subscribeToCacheEntry(cacheEntry, container, requery, signal);
                return cacheEntry.promise.then(function(res) {
                  return {
                    result: applyOptimisticOps(res.result, req, tblCache === null || tblCache === void 0 ? void 0 : tblCache.optimisticOps, downTable, cacheEntry, freezeResults)
                  };
                });
              }, "query") });
              return tableMW;
            }, "table") });
            return coreMW;
          }, "create")
        };
        function vipify(target, vipDb) {
          return new Proxy(target, {
            get: /* @__PURE__ */ __name(function(target2, prop, receiver) {
              if (prop === "db")
                return vipDb;
              return Reflect.get(target2, prop, receiver);
            }, "get")
          });
        }
        __name(vipify, "vipify");
        var Dexie$1 = function() {
          function Dexie3(name, options2) {
            var _this = this;
            this._middlewares = {};
            this.verno = 0;
            var deps = Dexie3.dependencies;
            this._options = options2 = __assign({
              addons: Dexie3.addons,
              autoOpen: true,
              indexedDB: deps.indexedDB,
              IDBKeyRange: deps.IDBKeyRange,
              cache: "cloned"
            }, options2);
            this._deps = {
              indexedDB: options2.indexedDB,
              IDBKeyRange: options2.IDBKeyRange
            };
            var addons = options2.addons;
            this._dbSchema = {};
            this._versions = [];
            this._storeNames = [];
            this._allTables = {};
            this.idbdb = null;
            this._novip = this;
            var state = {
              dbOpenError: null,
              isBeingOpened: false,
              onReadyBeingFired: null,
              openComplete: false,
              dbReadyResolve: nop,
              dbReadyPromise: null,
              cancelOpen: nop,
              openCanceller: null,
              autoSchema: true,
              PR1398_maxLoop: 3,
              autoOpen: options2.autoOpen
            };
            state.dbReadyPromise = new DexiePromise(function(resolve) {
              state.dbReadyResolve = resolve;
            });
            state.openCanceller = new DexiePromise(function(_3, reject) {
              state.cancelOpen = reject;
            });
            this._state = state;
            this.name = name;
            this.on = Events(this, "populate", "blocked", "versionchange", "close", { ready: [promisableChain, nop] });
            this.on.ready.subscribe = override(this.on.ready.subscribe, function(subscribe) {
              return function(subscriber, bSticky) {
                Dexie3.vip(function() {
                  var state2 = _this._state;
                  if (state2.openComplete) {
                    if (!state2.dbOpenError)
                      DexiePromise.resolve().then(subscriber);
                    if (bSticky)
                      subscribe(subscriber);
                  } else if (state2.onReadyBeingFired) {
                    state2.onReadyBeingFired.push(subscriber);
                    if (bSticky)
                      subscribe(subscriber);
                  } else {
                    subscribe(subscriber);
                    var db_1 = _this;
                    if (!bSticky)
                      subscribe(/* @__PURE__ */ __name(function unsubscribe() {
                        db_1.on.ready.unsubscribe(subscriber);
                        db_1.on.ready.unsubscribe(unsubscribe);
                      }, "unsubscribe"));
                  }
                });
              };
            });
            this.Collection = createCollectionConstructor(this);
            this.Table = createTableConstructor(this);
            this.Transaction = createTransactionConstructor(this);
            this.Version = createVersionConstructor(this);
            this.WhereClause = createWhereClauseConstructor(this);
            this.on("versionchange", function(ev) {
              if (ev.newVersion > 0)
                console.warn("Another connection wants to upgrade database '".concat(_this.name, "'. Closing db now to resume the upgrade."));
              else
                console.warn("Another connection wants to delete database '".concat(_this.name, "'. Closing db now to resume the delete request."));
              _this.close({ disableAutoOpen: false });
            });
            this.on("blocked", function(ev) {
              if (!ev.newVersion || ev.newVersion < ev.oldVersion)
                console.warn("Dexie.delete('".concat(_this.name, "') was blocked"));
              else
                console.warn("Upgrade '".concat(_this.name, "' blocked by other connection holding version ").concat(ev.oldVersion / 10));
            });
            this._maxKey = getMaxKey(options2.IDBKeyRange);
            this._createTransaction = function(mode, storeNames, dbschema, parentTransaction) {
              return new _this.Transaction(mode, storeNames, dbschema, _this._options.chromeTransactionDurability, parentTransaction);
            };
            this._fireOnBlocked = function(ev) {
              _this.on("blocked").fire(ev);
              connections.filter(function(c3) {
                return c3.name === _this.name && c3 !== _this && !c3._state.vcFired;
              }).map(function(c3) {
                return c3.on("versionchange").fire(ev);
              });
            };
            this.use(cacheExistingValuesMiddleware);
            this.use(cacheMiddleware);
            this.use(observabilityMiddleware);
            this.use(virtualIndexMiddleware);
            this.use(hooksMiddleware);
            var vipDB = new Proxy(this, {
              get: /* @__PURE__ */ __name(function(_3, prop, receiver) {
                if (prop === "_vip")
                  return true;
                if (prop === "table")
                  return function(tableName) {
                    return vipify(_this.table(tableName), vipDB);
                  };
                var rv = Reflect.get(_3, prop, receiver);
                if (rv instanceof Table)
                  return vipify(rv, vipDB);
                if (prop === "tables")
                  return rv.map(function(t4) {
                    return vipify(t4, vipDB);
                  });
                if (prop === "_createTransaction")
                  return function() {
                    var tx = rv.apply(this, arguments);
                    return vipify(tx, vipDB);
                  };
                return rv;
              }, "get")
            });
            this.vip = vipDB;
            addons.forEach(function(addon) {
              return addon(_this);
            });
          }
          __name(Dexie3, "Dexie");
          Dexie3.prototype.version = function(versionNumber) {
            if (isNaN(versionNumber) || versionNumber < 0.1)
              throw new exceptions.Type("Given version is not a positive number");
            versionNumber = Math.round(versionNumber * 10) / 10;
            if (this.idbdb || this._state.isBeingOpened)
              throw new exceptions.Schema("Cannot add version when database is open");
            this.verno = Math.max(this.verno, versionNumber);
            var versions = this._versions;
            var versionInstance = versions.filter(function(v3) {
              return v3._cfg.version === versionNumber;
            })[0];
            if (versionInstance)
              return versionInstance;
            versionInstance = new this.Version(versionNumber);
            versions.push(versionInstance);
            versions.sort(lowerVersionFirst);
            versionInstance.stores({});
            this._state.autoSchema = false;
            return versionInstance;
          };
          Dexie3.prototype._whenReady = function(fn2) {
            var _this = this;
            return this.idbdb && (this._state.openComplete || PSD.letThrough || this._vip) ? fn2() : new DexiePromise(function(resolve, reject) {
              if (_this._state.openComplete) {
                return reject(new exceptions.DatabaseClosed(_this._state.dbOpenError));
              }
              if (!_this._state.isBeingOpened) {
                if (!_this._state.autoOpen) {
                  reject(new exceptions.DatabaseClosed());
                  return;
                }
                _this.open().catch(nop);
              }
              _this._state.dbReadyPromise.then(resolve, reject);
            }).then(fn2);
          };
          Dexie3.prototype.use = function(_a2) {
            var stack = _a2.stack, create = _a2.create, level = _a2.level, name = _a2.name;
            if (name)
              this.unuse({ stack, name });
            var middlewares = this._middlewares[stack] || (this._middlewares[stack] = []);
            middlewares.push({ stack, create, level: level == null ? 10 : level, name });
            middlewares.sort(function(a3, b2) {
              return a3.level - b2.level;
            });
            return this;
          };
          Dexie3.prototype.unuse = function(_a2) {
            var stack = _a2.stack, name = _a2.name, create = _a2.create;
            if (stack && this._middlewares[stack]) {
              this._middlewares[stack] = this._middlewares[stack].filter(function(mw) {
                return create ? mw.create !== create : name ? mw.name !== name : false;
              });
            }
            return this;
          };
          Dexie3.prototype.open = function() {
            var _this = this;
            return usePSD(
              globalPSD,
              function() {
                return dexieOpen(_this);
              }
            );
          };
          Dexie3.prototype._close = function() {
            var state = this._state;
            var idx = connections.indexOf(this);
            if (idx >= 0)
              connections.splice(idx, 1);
            if (this.idbdb) {
              try {
                this.idbdb.close();
              } catch (e3) {
              }
              this.idbdb = null;
            }
            if (!state.isBeingOpened) {
              state.dbReadyPromise = new DexiePromise(function(resolve) {
                state.dbReadyResolve = resolve;
              });
              state.openCanceller = new DexiePromise(function(_3, reject) {
                state.cancelOpen = reject;
              });
            }
          };
          Dexie3.prototype.close = function(_a2) {
            var _b = _a2 === void 0 ? { disableAutoOpen: true } : _a2, disableAutoOpen = _b.disableAutoOpen;
            var state = this._state;
            if (disableAutoOpen) {
              if (state.isBeingOpened) {
                state.cancelOpen(new exceptions.DatabaseClosed());
              }
              this._close();
              state.autoOpen = false;
              state.dbOpenError = new exceptions.DatabaseClosed();
            } else {
              this._close();
              state.autoOpen = this._options.autoOpen || state.isBeingOpened;
              state.openComplete = false;
              state.dbOpenError = null;
            }
          };
          Dexie3.prototype.delete = function(closeOptions) {
            var _this = this;
            if (closeOptions === void 0) {
              closeOptions = { disableAutoOpen: true };
            }
            var hasInvalidArguments = arguments.length > 0 && typeof arguments[0] !== "object";
            var state = this._state;
            return new DexiePromise(function(resolve, reject) {
              var doDelete = /* @__PURE__ */ __name(function() {
                _this.close(closeOptions);
                var req = _this._deps.indexedDB.deleteDatabase(_this.name);
                req.onsuccess = wrap2(function() {
                  _onDatabaseDeleted(_this._deps, _this.name);
                  resolve();
                });
                req.onerror = eventRejectHandler(reject);
                req.onblocked = _this._fireOnBlocked;
              }, "doDelete");
              if (hasInvalidArguments)
                throw new exceptions.InvalidArgument("Invalid closeOptions argument to db.delete()");
              if (state.isBeingOpened) {
                state.dbReadyPromise.then(doDelete);
              } else {
                doDelete();
              }
            });
          };
          Dexie3.prototype.backendDB = function() {
            return this.idbdb;
          };
          Dexie3.prototype.isOpen = function() {
            return this.idbdb !== null;
          };
          Dexie3.prototype.hasBeenClosed = function() {
            var dbOpenError = this._state.dbOpenError;
            return dbOpenError && dbOpenError.name === "DatabaseClosed";
          };
          Dexie3.prototype.hasFailed = function() {
            return this._state.dbOpenError !== null;
          };
          Dexie3.prototype.dynamicallyOpened = function() {
            return this._state.autoSchema;
          };
          Object.defineProperty(Dexie3.prototype, "tables", {
            get: /* @__PURE__ */ __name(function() {
              var _this = this;
              return keys(this._allTables).map(function(name) {
                return _this._allTables[name];
              });
            }, "get"),
            enumerable: false,
            configurable: true
          });
          Dexie3.prototype.transaction = function() {
            var args = extractTransactionArgs.apply(this, arguments);
            return this._transaction.apply(this, args);
          };
          Dexie3.prototype._transaction = function(mode, tables, scopeFunc) {
            var _this = this;
            var parentTransaction = PSD.trans;
            if (!parentTransaction || parentTransaction.db !== this || mode.indexOf("!") !== -1)
              parentTransaction = null;
            var onlyIfCompatible = mode.indexOf("?") !== -1;
            mode = mode.replace("!", "").replace("?", "");
            var idbMode, storeNames;
            try {
              storeNames = tables.map(function(table) {
                var storeName = table instanceof _this.Table ? table.name : table;
                if (typeof storeName !== "string")
                  throw new TypeError("Invalid table argument to Dexie.transaction(). Only Table or String are allowed");
                return storeName;
              });
              if (mode == "r" || mode === READONLY)
                idbMode = READONLY;
              else if (mode == "rw" || mode == READWRITE)
                idbMode = READWRITE;
              else
                throw new exceptions.InvalidArgument("Invalid transaction mode: " + mode);
              if (parentTransaction) {
                if (parentTransaction.mode === READONLY && idbMode === READWRITE) {
                  if (onlyIfCompatible) {
                    parentTransaction = null;
                  } else
                    throw new exceptions.SubTransaction("Cannot enter a sub-transaction with READWRITE mode when parent transaction is READONLY");
                }
                if (parentTransaction) {
                  storeNames.forEach(function(storeName) {
                    if (parentTransaction && parentTransaction.storeNames.indexOf(storeName) === -1) {
                      if (onlyIfCompatible) {
                        parentTransaction = null;
                      } else
                        throw new exceptions.SubTransaction("Table " + storeName + " not included in parent transaction.");
                    }
                  });
                }
                if (onlyIfCompatible && parentTransaction && !parentTransaction.active) {
                  parentTransaction = null;
                }
              }
            } catch (e3) {
              return parentTransaction ? parentTransaction._promise(null, function(_3, reject) {
                reject(e3);
              }) : rejection(e3);
            }
            var enterTransaction = enterTransactionScope.bind(null, this, idbMode, storeNames, parentTransaction, scopeFunc);
            return parentTransaction ? parentTransaction._promise(idbMode, enterTransaction, "lock") : PSD.trans ? usePSD(PSD.transless, function() {
              return _this._whenReady(enterTransaction);
            }) : this._whenReady(enterTransaction);
          };
          Dexie3.prototype.table = function(tableName) {
            if (!hasOwn(this._allTables, tableName)) {
              throw new exceptions.InvalidTable("Table ".concat(tableName, " does not exist"));
            }
            return this._allTables[tableName];
          };
          return Dexie3;
        }();
        var symbolObservable = typeof Symbol !== "undefined" && "observable" in Symbol ? Symbol.observable : "@@observable";
        var Observable = function() {
          function Observable2(subscribe) {
            this._subscribe = subscribe;
          }
          __name(Observable2, "Observable");
          Observable2.prototype.subscribe = function(x4, error, complete) {
            return this._subscribe(!x4 || typeof x4 === "function" ? { next: x4, error, complete } : x4);
          };
          Observable2.prototype[symbolObservable] = function() {
            return this;
          };
          return Observable2;
        }();
        var domDeps;
        try {
          domDeps = {
            indexedDB: _global.indexedDB || _global.mozIndexedDB || _global.webkitIndexedDB || _global.msIndexedDB,
            IDBKeyRange: _global.IDBKeyRange || _global.webkitIDBKeyRange
          };
        } catch (e3) {
          domDeps = { indexedDB: null, IDBKeyRange: null };
        }
        function liveQuery2(querier) {
          var hasValue = false;
          var currentValue;
          var observable = new Observable(function(observer) {
            var scopeFuncIsAsync = isAsyncFunction(querier);
            function execute(ctx) {
              var wasRootExec = beginMicroTickScope();
              try {
                if (scopeFuncIsAsync) {
                  incrementExpectedAwaits();
                }
                var rv = newScope(querier, ctx);
                if (scopeFuncIsAsync) {
                  rv = rv.finally(decrementExpectedAwaits);
                }
                return rv;
              } finally {
                wasRootExec && endMicroTickScope();
              }
            }
            __name(execute, "execute");
            var closed = false;
            var abortController;
            var accumMuts = {};
            var currentObs = {};
            var subscription = {
              get closed() {
                return closed;
              },
              unsubscribe: /* @__PURE__ */ __name(function() {
                if (closed)
                  return;
                closed = true;
                if (abortController)
                  abortController.abort();
                if (startedListening)
                  globalEvents.storagemutated.unsubscribe(mutationListener);
              }, "unsubscribe")
            };
            observer.start && observer.start(subscription);
            var startedListening = false;
            var doQuery = /* @__PURE__ */ __name(function() {
              return execInGlobalContext(_doQuery);
            }, "doQuery");
            function shouldNotify() {
              return obsSetsOverlap(currentObs, accumMuts);
            }
            __name(shouldNotify, "shouldNotify");
            var mutationListener = /* @__PURE__ */ __name(function(parts) {
              extendObservabilitySet(accumMuts, parts);
              if (shouldNotify()) {
                doQuery();
              }
            }, "mutationListener");
            var _doQuery = /* @__PURE__ */ __name(function() {
              if (closed || !domDeps.indexedDB) {
                return;
              }
              accumMuts = {};
              var subscr = {};
              if (abortController)
                abortController.abort();
              abortController = new AbortController();
              var ctx = {
                subscr,
                signal: abortController.signal,
                requery: doQuery,
                querier,
                trans: null
              };
              var ret = execute(ctx);
              Promise.resolve(ret).then(function(result) {
                hasValue = true;
                currentValue = result;
                if (closed || ctx.signal.aborted) {
                  return;
                }
                accumMuts = {};
                currentObs = subscr;
                if (!objectIsEmpty(currentObs) && !startedListening) {
                  globalEvents(DEXIE_STORAGE_MUTATED_EVENT_NAME, mutationListener);
                  startedListening = true;
                }
                execInGlobalContext(function() {
                  return !closed && observer.next && observer.next(result);
                });
              }, function(err) {
                hasValue = false;
                if (!["DatabaseClosedError", "AbortError"].includes(err === null || err === void 0 ? void 0 : err.name)) {
                  if (!closed)
                    execInGlobalContext(function() {
                      if (closed)
                        return;
                      observer.error && observer.error(err);
                    });
                }
              });
            }, "_doQuery");
            setTimeout(doQuery, 0);
            return subscription;
          });
          observable.hasValue = function() {
            return hasValue;
          };
          observable.getValue = function() {
            return currentValue;
          };
          return observable;
        }
        __name(liveQuery2, "liveQuery");
        var Dexie2 = Dexie$1;
        props(Dexie2, __assign(__assign({}, fullNameExceptions), {
          delete: /* @__PURE__ */ __name(function(databaseName) {
            var db = new Dexie2(databaseName, { addons: [] });
            return db.delete();
          }, "delete"),
          exists: /* @__PURE__ */ __name(function(name) {
            return new Dexie2(name, { addons: [] }).open().then(function(db) {
              db.close();
              return true;
            }).catch("NoSuchDatabaseError", function() {
              return false;
            });
          }, "exists"),
          getDatabaseNames: /* @__PURE__ */ __name(function(cb) {
            try {
              return getDatabaseNames(Dexie2.dependencies).then(cb);
            } catch (_a2) {
              return rejection(new exceptions.MissingAPI());
            }
          }, "getDatabaseNames"),
          defineClass: /* @__PURE__ */ __name(function() {
            function Class(content) {
              extend(this, content);
            }
            __name(Class, "Class");
            return Class;
          }, "defineClass"),
          ignoreTransaction: /* @__PURE__ */ __name(function(scopeFunc) {
            return PSD.trans ? usePSD(PSD.transless, scopeFunc) : scopeFunc();
          }, "ignoreTransaction"),
          vip,
          async: /* @__PURE__ */ __name(function(generatorFn) {
            return function() {
              try {
                var rv = awaitIterator(generatorFn.apply(this, arguments));
                if (!rv || typeof rv.then !== "function")
                  return DexiePromise.resolve(rv);
                return rv;
              } catch (e3) {
                return rejection(e3);
              }
            };
          }, "async"),
          spawn: /* @__PURE__ */ __name(function(generatorFn, args, thiz) {
            try {
              var rv = awaitIterator(generatorFn.apply(thiz, args || []));
              if (!rv || typeof rv.then !== "function")
                return DexiePromise.resolve(rv);
              return rv;
            } catch (e3) {
              return rejection(e3);
            }
          }, "spawn"),
          currentTransaction: {
            get: /* @__PURE__ */ __name(function() {
              return PSD.trans || null;
            }, "get")
          },
          waitFor: /* @__PURE__ */ __name(function(promiseOrFunction, optionalTimeout) {
            var promise = DexiePromise.resolve(typeof promiseOrFunction === "function" ? Dexie2.ignoreTransaction(promiseOrFunction) : promiseOrFunction).timeout(optionalTimeout || 6e4);
            return PSD.trans ? PSD.trans.waitFor(promise) : promise;
          }, "waitFor"),
          Promise: DexiePromise,
          debug: {
            get: /* @__PURE__ */ __name(function() {
              return debug;
            }, "get"),
            set: /* @__PURE__ */ __name(function(value) {
              setDebug(value);
            }, "set")
          },
          derive,
          extend,
          props,
          override,
          Events,
          on: globalEvents,
          liveQuery: liveQuery2,
          extendObservabilitySet,
          getByKeyPath,
          setByKeyPath,
          delByKeyPath,
          shallowClone,
          deepClone,
          getObjectDiff,
          cmp: cmp2,
          asap: asap$1,
          minKey,
          addons: [],
          connections,
          errnames,
          dependencies: domDeps,
          cache,
          semVer: DEXIE_VERSION,
          version: DEXIE_VERSION.split(".").map(function(n3) {
            return parseInt(n3);
          }).reduce(function(p3, c3, i3) {
            return p3 + c3 / Math.pow(10, i3 * 2);
          })
        }));
        Dexie2.maxKey = getMaxKey(Dexie2.dependencies.IDBKeyRange);
        if (typeof dispatchEvent !== "undefined" && typeof addEventListener !== "undefined") {
          globalEvents(DEXIE_STORAGE_MUTATED_EVENT_NAME, function(updatedParts) {
            if (!propagatingLocally) {
              var event_1;
              event_1 = new CustomEvent(STORAGE_MUTATED_DOM_EVENT_NAME, {
                detail: updatedParts
              });
              propagatingLocally = true;
              dispatchEvent(event_1);
              propagatingLocally = false;
            }
          });
          addEventListener(STORAGE_MUTATED_DOM_EVENT_NAME, function(_a2) {
            var detail = _a2.detail;
            if (!propagatingLocally) {
              propagateLocally(detail);
            }
          });
        }
        function propagateLocally(updateParts) {
          var wasMe = propagatingLocally;
          try {
            propagatingLocally = true;
            globalEvents.storagemutated.fire(updateParts);
            signalSubscribersNow(updateParts, true);
          } finally {
            propagatingLocally = wasMe;
          }
        }
        __name(propagateLocally, "propagateLocally");
        var propagatingLocally = false;
        var bc;
        var createBC = /* @__PURE__ */ __name(function() {
        }, "createBC");
        if (typeof BroadcastChannel !== "undefined") {
          createBC = /* @__PURE__ */ __name(function() {
            bc = new BroadcastChannel(STORAGE_MUTATED_DOM_EVENT_NAME);
            bc.onmessage = function(ev) {
              return ev.data && propagateLocally(ev.data);
            };
          }, "createBC");
          createBC();
          if (typeof bc.unref === "function") {
            bc.unref();
          }
          globalEvents(DEXIE_STORAGE_MUTATED_EVENT_NAME, function(changedParts) {
            if (!propagatingLocally) {
              bc.postMessage(changedParts);
            }
          });
        }
        if (typeof addEventListener !== "undefined") {
          addEventListener("pagehide", function(event) {
            if (!Dexie$1.disableBfCache && event.persisted) {
              if (debug)
                console.debug("Dexie: handling persisted pagehide");
              bc === null || bc === void 0 ? void 0 : bc.close();
              for (var _i = 0, connections_1 = connections; _i < connections_1.length; _i++) {
                var db = connections_1[_i];
                db.close({ disableAutoOpen: false });
              }
            }
          });
          addEventListener("pageshow", function(event) {
            if (!Dexie$1.disableBfCache && event.persisted) {
              if (debug)
                console.debug("Dexie: handling persisted pageshow");
              createBC();
              propagateLocally({ all: new RangeSet2(-Infinity, [[]]) });
            }
          });
        }
        function add2(value) {
          return new PropModification2({ add: value });
        }
        __name(add2, "add");
        function remove3(value) {
          return new PropModification2({ remove: value });
        }
        __name(remove3, "remove");
        function replacePrefix2(a3, b2) {
          return new PropModification2({ replacePrefix: [a3, b2] });
        }
        __name(replacePrefix2, "replacePrefix");
        DexiePromise.rejectionMapper = mapError;
        setDebug(debug);
        var namedExports = /* @__PURE__ */ Object.freeze({
          __proto__: null,
          Dexie: Dexie$1,
          liveQuery: liveQuery2,
          Entity: Entity2,
          cmp: cmp2,
          PropModification: PropModification2,
          replacePrefix: replacePrefix2,
          add: add2,
          remove: remove3,
          "default": Dexie$1,
          RangeSet: RangeSet2,
          mergeRanges: mergeRanges2,
          rangesOverlap: rangesOverlap2
        });
        __assign(Dexie$1, namedExports, { default: Dexie$1 });
        return Dexie$1;
      });
    }
  });

  // node_modules/lucide-preact/dist/esm/shared/src/utils.js
  var toKebabCase, toCamelCase, toPascalCase, mergeClasses;
  var init_utils = __esm({
    "node_modules/lucide-preact/dist/esm/shared/src/utils.js"() {
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      toKebabCase = /* @__PURE__ */ __name((string) => string.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(), "toKebabCase");
      toCamelCase = /* @__PURE__ */ __name((string) => string.replace(
        /^([A-Z])|[\s-_]+(\w)/g,
        (match, p1, p22) => p22 ? p22.toUpperCase() : p1.toLowerCase()
      ), "toCamelCase");
      toPascalCase = /* @__PURE__ */ __name((string) => {
        const camelCase = toCamelCase(string);
        return camelCase.charAt(0).toUpperCase() + camelCase.slice(1);
      }, "toPascalCase");
      mergeClasses = /* @__PURE__ */ __name((...classes) => classes.filter((className, index, array) => {
        return Boolean(className) && className.trim() !== "" && array.indexOf(className) === index;
      }).join(" ").trim(), "mergeClasses");
    }
  });

  // node_modules/lucide-preact/dist/esm/defaultAttributes.js
  var defaultAttributes;
  var init_defaultAttributes = __esm({
    "node_modules/lucide-preact/dist/esm/defaultAttributes.js"() {
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      defaultAttributes = {
        xmlns: "http://www.w3.org/2000/svg",
        width: 24,
        height: 24,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round"
      };
    }
  });

  // node_modules/lucide-preact/dist/esm/Icon.js
  var Icon;
  var init_Icon = __esm({
    "node_modules/lucide-preact/dist/esm/Icon.js"() {
      init_preact_module();
      init_defaultAttributes();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      Icon = /* @__PURE__ */ __name(({
        color = "currentColor",
        size = 24,
        strokeWidth = 2,
        absoluteStrokeWidth,
        children,
        iconNode,
        class: classes = "",
        ...rest
      }) => _(
        "svg",
        {
          ...defaultAttributes,
          width: String(size),
          height: size,
          stroke: color,
          ["stroke-width"]: absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(size) : strokeWidth,
          class: ["lucide", classes].join(" "),
          ...rest
        },
        [...iconNode.map(([tag2, attrs]) => _(tag2, attrs)), ...H(children)]
      ), "Icon");
    }
  });

  // node_modules/lucide-preact/dist/esm/createLucideIcon.js
  var createLucideIcon;
  var init_createLucideIcon = __esm({
    "node_modules/lucide-preact/dist/esm/createLucideIcon.js"() {
      init_preact_module();
      init_utils();
      init_Icon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      createLucideIcon = /* @__PURE__ */ __name((iconName, iconNode) => {
        const Component = /* @__PURE__ */ __name(({ class: classes = "", children, ...props }) => _(
          Icon,
          {
            ...props,
            iconNode,
            class: mergeClasses(
              `lucide-${toKebabCase(toPascalCase(iconName))}`,
              `lucide-${toKebabCase(iconName)}`,
              classes
            )
          },
          children
        ), "Component");
        Component.displayName = toPascalCase(iconName);
        return Component;
      }, "createLucideIcon");
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/box.js
  var Box;
  var init_box = __esm({
    "node_modules/lucide-preact/dist/esm/icons/box.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      Box = createLucideIcon("box", [
        [
          "path",
          {
            d: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
            key: "hh9hay"
          }
        ],
        ["path", { d: "m3.3 7 8.7 5 8.7-5", key: "g66t2b" }],
        ["path", { d: "M12 22V12", key: "d0xqtd" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/boxes.js
  var Boxes;
  var init_boxes = __esm({
    "node_modules/lucide-preact/dist/esm/icons/boxes.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      Boxes = createLucideIcon("boxes", [
        [
          "path",
          {
            d: "M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z",
            key: "lc1i9w"
          }
        ],
        ["path", { d: "m7 16.5-4.74-2.85", key: "1o9zyk" }],
        ["path", { d: "m7 16.5 5-3", key: "va8pkn" }],
        ["path", { d: "M7 16.5v5.17", key: "jnp8gn" }],
        [
          "path",
          {
            d: "M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z",
            key: "8zsnat"
          }
        ],
        ["path", { d: "m17 16.5-5-3", key: "8arw3v" }],
        ["path", { d: "m17 16.5 4.74-2.85", key: "8rfmw" }],
        ["path", { d: "M17 16.5v5.17", key: "k6z78m" }],
        [
          "path",
          {
            d: "M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z",
            key: "1xygjf"
          }
        ],
        ["path", { d: "M12 8 7.26 5.15", key: "1vbdud" }],
        ["path", { d: "m12 8 4.74-2.85", key: "3rx089" }],
        ["path", { d: "M12 13.5V8", key: "1io7kd" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/check.js
  var Check;
  var init_check = __esm({
    "node_modules/lucide-preact/dist/esm/icons/check.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      Check = createLucideIcon("check", [["path", { d: "M20 6 9 17l-5-5", key: "1gmf2c" }]]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/chevron-down.js
  var ChevronDown;
  var init_chevron_down = __esm({
    "node_modules/lucide-preact/dist/esm/icons/chevron-down.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      ChevronDown = createLucideIcon("chevron-down", [
        ["path", { d: "m6 9 6 6 6-6", key: "qrunsl" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/circle-chevron-down.js
  var CircleChevronDown;
  var init_circle_chevron_down = __esm({
    "node_modules/lucide-preact/dist/esm/icons/circle-chevron-down.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      CircleChevronDown = createLucideIcon("circle-chevron-down", [
        ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
        ["path", { d: "m16 10-4 4-4-4", key: "894hmk" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/circle-off.js
  var CircleOff;
  var init_circle_off = __esm({
    "node_modules/lucide-preact/dist/esm/icons/circle-off.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      CircleOff = createLucideIcon("circle-off", [
        ["path", { d: "m2 2 20 20", key: "1ooewy" }],
        ["path", { d: "M8.35 2.69A10 10 0 0 1 21.3 15.65", key: "1pfsoa" }],
        ["path", { d: "M19.08 19.08A10 10 0 1 1 4.92 4.92", key: "1ablyi" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/circle-user.js
  var CircleUser;
  var init_circle_user = __esm({
    "node_modules/lucide-preact/dist/esm/icons/circle-user.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      CircleUser = createLucideIcon("circle-user", [
        ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
        ["circle", { cx: "12", cy: "10", r: "3", key: "ilqhr7" }],
        ["path", { d: "M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662", key: "154egf" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/house.js
  var House;
  var init_house = __esm({
    "node_modules/lucide-preact/dist/esm/icons/house.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      House = createLucideIcon("house", [
        ["path", { d: "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8", key: "5wwlr5" }],
        [
          "path",
          {
            d: "M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
            key: "1d0kgt"
          }
        ]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/info.js
  var Info;
  var init_info = __esm({
    "node_modules/lucide-preact/dist/esm/icons/info.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      Info = createLucideIcon("info", [
        ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
        ["path", { d: "M12 16v-4", key: "1dtifu" }],
        ["path", { d: "M12 8h.01", key: "e9boi3" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/key-round.js
  var KeyRound;
  var init_key_round = __esm({
    "node_modules/lucide-preact/dist/esm/icons/key-round.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      KeyRound = createLucideIcon("key-round", [
        [
          "path",
          {
            d: "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z",
            key: "1s6t7t"
          }
        ],
        ["circle", { cx: "16.5", cy: "7.5", r: ".5", fill: "currentColor", key: "w0ekpg" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/loader-circle.js
  var LoaderCircle;
  var init_loader_circle = __esm({
    "node_modules/lucide-preact/dist/esm/icons/loader-circle.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      LoaderCircle = createLucideIcon("loader-circle", [
        ["path", { d: "M21 12a9 9 0 1 1-6.219-8.56", key: "13zald" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/lock.js
  var Lock;
  var init_lock = __esm({
    "node_modules/lucide-preact/dist/esm/icons/lock.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      Lock = createLucideIcon("lock", [
        ["rect", { width: "18", height: "11", x: "3", y: "11", rx: "2", ry: "2", key: "1w4ew1" }],
        ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4", key: "fwvmzm" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/mail-check.js
  var MailCheck;
  var init_mail_check = __esm({
    "node_modules/lucide-preact/dist/esm/icons/mail-check.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      MailCheck = createLucideIcon("mail-check", [
        ["path", { d: "M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8", key: "12jkf8" }],
        ["path", { d: "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7", key: "1ocrg3" }],
        ["path", { d: "m16 19 2 2 4-4", key: "1b14m6" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/mail.js
  var Mail;
  var init_mail = __esm({
    "node_modules/lucide-preact/dist/esm/icons/mail.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      Mail = createLucideIcon("mail", [
        ["path", { d: "m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7", key: "132q7q" }],
        ["rect", { x: "2", y: "4", width: "20", height: "16", rx: "2", key: "izxlao" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/mails.js
  var Mails;
  var init_mails = __esm({
    "node_modules/lucide-preact/dist/esm/icons/mails.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      Mails = createLucideIcon("mails", [
        ["rect", { width: "16", height: "13", x: "6", y: "4", rx: "2", key: "1drq3f" }],
        ["path", { d: "m22 7-7.1 3.78c-.57.3-1.23.3-1.8 0L6 7", key: "xn252p" }],
        ["path", { d: "M2 8v11c0 1.1.9 2 2 2h14", key: "n13cji" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/megaphone.js
  var Megaphone;
  var init_megaphone = __esm({
    "node_modules/lucide-preact/dist/esm/icons/megaphone.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      Megaphone = createLucideIcon("megaphone", [
        [
          "path",
          {
            d: "M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
            key: "q8bfy3"
          }
        ],
        ["path", { d: "M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14", key: "1853fq" }],
        ["path", { d: "M8 6v8", key: "15ugcq" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/octagon-alert.js
  var OctagonAlert;
  var init_octagon_alert = __esm({
    "node_modules/lucide-preact/dist/esm/icons/octagon-alert.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      OctagonAlert = createLucideIcon("octagon-alert", [
        ["path", { d: "M12 16h.01", key: "1drbdi" }],
        ["path", { d: "M12 8v4", key: "1got3b" }],
        [
          "path",
          {
            d: "M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z",
            key: "1fd625"
          }
        ]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/party-popper.js
  var PartyPopper;
  var init_party_popper = __esm({
    "node_modules/lucide-preact/dist/esm/icons/party-popper.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      PartyPopper = createLucideIcon("party-popper", [
        ["path", { d: "M5.8 11.3 2 22l10.7-3.79", key: "gwxi1d" }],
        ["path", { d: "M4 3h.01", key: "1vcuye" }],
        ["path", { d: "M22 8h.01", key: "1mrtc2" }],
        ["path", { d: "M15 2h.01", key: "1cjtqr" }],
        ["path", { d: "M22 20h.01", key: "1mrys2" }],
        [
          "path",
          {
            d: "m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10",
            key: "hbicv8"
          }
        ],
        [
          "path",
          { d: "m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17", key: "1i94pl" }
        ],
        ["path", { d: "m11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7", key: "1cofks" }],
        [
          "path",
          {
            d: "M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z",
            key: "4kbmks"
          }
        ]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/phone-incoming.js
  var PhoneIncoming;
  var init_phone_incoming = __esm({
    "node_modules/lucide-preact/dist/esm/icons/phone-incoming.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      PhoneIncoming = createLucideIcon("phone-incoming", [
        ["path", { d: "M16 2v6h6", key: "1mfrl5" }],
        ["path", { d: "m22 2-6 6", key: "6f0sa0" }],
        [
          "path",
          {
            d: "M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384",
            key: "9njp5v"
          }
        ]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/phone.js
  var Phone;
  var init_phone = __esm({
    "node_modules/lucide-preact/dist/esm/icons/phone.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      Phone = createLucideIcon("phone", [
        [
          "path",
          {
            d: "M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384",
            key: "9njp5v"
          }
        ]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/search.js
  var Search;
  var init_search = __esm({
    "node_modules/lucide-preact/dist/esm/icons/search.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      Search = createLucideIcon("search", [
        ["path", { d: "m21 21-4.34-4.34", key: "14j7rj" }],
        ["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/server-cog.js
  var ServerCog;
  var init_server_cog = __esm({
    "node_modules/lucide-preact/dist/esm/icons/server-cog.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      ServerCog = createLucideIcon("server-cog", [
        ["path", { d: "m10.852 14.772-.383.923", key: "11vil6" }],
        ["path", { d: "M13.148 14.772a3 3 0 1 0-2.296-5.544l-.383-.923", key: "1v3clb" }],
        ["path", { d: "m13.148 9.228.383-.923", key: "t2zzyc" }],
        ["path", { d: "m13.53 15.696-.382-.924a3 3 0 1 1-2.296-5.544", key: "1bxfiv" }],
        ["path", { d: "m14.772 10.852.923-.383", key: "k9m8cz" }],
        ["path", { d: "m14.772 13.148.923.383", key: "1xvhww" }],
        [
          "path",
          {
            d: "M4.5 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5",
            key: "tn8das"
          }
        ],
        [
          "path",
          {
            d: "M4.5 14H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-.5",
            key: "1g2pve"
          }
        ],
        ["path", { d: "M6 18h.01", key: "uhywen" }],
        ["path", { d: "M6 6h.01", key: "1utrut" }],
        ["path", { d: "m9.228 10.852-.923-.383", key: "1wtb30" }],
        ["path", { d: "m9.228 13.148-.923.383", key: "1a830x" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/shield-question-mark.js
  var ShieldQuestionMark;
  var init_shield_question_mark = __esm({
    "node_modules/lucide-preact/dist/esm/icons/shield-question-mark.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      ShieldQuestionMark = createLucideIcon("shield-question-mark", [
        [
          "path",
          {
            d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
            key: "oel41y"
          }
        ],
        ["path", { d: "M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3", key: "mhlwft" }],
        ["path", { d: "M12 17h.01", key: "p32p05" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/shield-user.js
  var ShieldUser;
  var init_shield_user = __esm({
    "node_modules/lucide-preact/dist/esm/icons/shield-user.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      ShieldUser = createLucideIcon("shield-user", [
        [
          "path",
          {
            d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
            key: "oel41y"
          }
        ],
        ["path", { d: "M6.376 18.91a6 6 0 0 1 11.249.003", key: "hnjrf2" }],
        ["circle", { cx: "12", cy: "11", r: "4", key: "1gt34v" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/superscript.js
  var Superscript;
  var init_superscript = __esm({
    "node_modules/lucide-preact/dist/esm/icons/superscript.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      Superscript = createLucideIcon("superscript", [
        ["path", { d: "m4 19 8-8", key: "hr47gm" }],
        ["path", { d: "m12 19-8-8", key: "1dhhmo" }],
        [
          "path",
          {
            d: "M20 12h-4c0-1.5.442-2 1.5-2.5S20 8.334 20 7.002c0-.472-.17-.93-.484-1.29a2.105 2.105 0 0 0-2.617-.436c-.42.239-.738.614-.899 1.06",
            key: "1dfcux"
          }
        ]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/triangle-alert.js
  var TriangleAlert;
  var init_triangle_alert = __esm({
    "node_modules/lucide-preact/dist/esm/icons/triangle-alert.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      TriangleAlert = createLucideIcon("triangle-alert", [
        [
          "path",
          {
            d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
            key: "wmoenq"
          }
        ],
        ["path", { d: "M12 9v4", key: "juzpu7" }],
        ["path", { d: "M12 17h.01", key: "p32p05" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/user-cog.js
  var UserCog;
  var init_user_cog = __esm({
    "node_modules/lucide-preact/dist/esm/icons/user-cog.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      UserCog = createLucideIcon("user-cog", [
        ["path", { d: "M10 15H6a4 4 0 0 0-4 4v2", key: "1nfge6" }],
        ["path", { d: "m14.305 16.53.923-.382", key: "1itpsq" }],
        ["path", { d: "m15.228 13.852-.923-.383", key: "eplpkm" }],
        ["path", { d: "m16.852 12.228-.383-.923", key: "13v3q0" }],
        ["path", { d: "m16.852 17.772-.383.924", key: "1i8mnm" }],
        ["path", { d: "m19.148 12.228.383-.923", key: "1q8j1v" }],
        ["path", { d: "m19.53 18.696-.382-.924", key: "vk1qj3" }],
        ["path", { d: "m20.772 13.852.924-.383", key: "n880s0" }],
        ["path", { d: "m20.772 16.148.924.383", key: "1g6xey" }],
        ["circle", { cx: "18", cy: "15", r: "3", key: "gjjjvw" }],
        ["circle", { cx: "9", cy: "7", r: "4", key: "nufk8" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/user-round-plus.js
  var UserRoundPlus;
  var init_user_round_plus = __esm({
    "node_modules/lucide-preact/dist/esm/icons/user-round-plus.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      UserRoundPlus = createLucideIcon("user-round-plus", [
        ["path", { d: "M2 21a8 8 0 0 1 13.292-6", key: "bjp14o" }],
        ["circle", { cx: "10", cy: "8", r: "5", key: "o932ke" }],
        ["path", { d: "M19 16v6", key: "tddt3s" }],
        ["path", { d: "M22 19h-6", key: "vcuq98" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/user-search.js
  var UserSearch;
  var init_user_search = __esm({
    "node_modules/lucide-preact/dist/esm/icons/user-search.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      UserSearch = createLucideIcon("user-search", [
        ["circle", { cx: "10", cy: "7", r: "4", key: "e45bow" }],
        ["path", { d: "M10.3 15H7a4 4 0 0 0-4 4v2", key: "3bnktk" }],
        ["circle", { cx: "17", cy: "17", r: "3", key: "18b49y" }],
        ["path", { d: "m21 21-1.9-1.9", key: "1g2n9r" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/icons/x.js
  var X2;
  var init_x = __esm({
    "node_modules/lucide-preact/dist/esm/icons/x.js"() {
      init_createLucideIcon();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
      X2 = createLucideIcon("x", [
        ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
        ["path", { d: "m6 6 12 12", key: "d8bk6v" }]
      ]);
    }
  });

  // node_modules/lucide-preact/dist/esm/lucide-preact.js
  var init_lucide_preact = __esm({
    "node_modules/lucide-preact/dist/esm/lucide-preact.js"() {
      init_circle_chevron_down();
      init_circle_user();
      init_house();
      init_loader_circle();
      init_octagon_alert();
      init_shield_question_mark();
      init_triangle_alert();
      init_user_round_plus();
      init_box();
      init_boxes();
      init_check();
      init_chevron_down();
      init_circle_off();
      init_info();
      init_key_round();
      init_lock();
      init_mail_check();
      init_mail();
      init_mails();
      init_megaphone();
      init_party_popper();
      init_phone_incoming();
      init_phone();
      init_search();
      init_server_cog();
      init_shield_user();
      init_superscript();
      init_user_cog();
      init_user_search();
      init_x();
      /**
       * @license lucide-preact v0.525.0 - ISC
       *
       * This source code is licensed under the ISC license.
       * See the LICENSE file in the root directory of this source tree.
       */
    }
  });

  // bips/Loading.js
  var html, Loading, Loading_default;
  var init_Loading = __esm({
    "bips/Loading.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_lucide_preact();
      html = htm_module_default.bind(_);
      Loading = /* @__PURE__ */ __name(({ center, margin, size = 24, strokeWidth = 2, ...props }) => {
        let extraStyles = "";
        if (center) {
          extraStyles += " loading-center";
        }
        if (margin) {
          extraStyles += " loading-margin";
        }
        return html`
        <div class="loading-container ${extraStyles}" ...${props}>
            <${LoaderCircle} class="spin" size=${size} strokeWidth=${strokeWidth} />
        </div>
    `;
      }, "Loading");
      Loading_default = Loading;
    }
  });

  // pages/BasicPageLayout.js
  var html2, BasicPageLayout, BasicPageLayout_default;
  var init_BasicPageLayout = __esm({
    "pages/BasicPageLayout.js"() {
      init_preact_module();
      init_hooks_module();
      init_src();
      init_htm_module();
      init_Loading();
      html2 = htm_module_default.bind(_);
      BasicPageLayout = /* @__PURE__ */ __name(({ title, loading, children, fullyTransparent = false, ...props }) => {
        let [version, setVersion] = d2(null);
        let [environment, setEnvironment] = d2(null);
        y2(async () => {
          let config = await window.Data.config();
          setVersion(config.app_version);
          setEnvironment(config.environment);
        }, []);
        let { url, path, query, route } = useLocation();
        const isHomePage = url === "/";
        const loadingOrChildren = loading ? html2`<${Loading_default} center margin />` : children;
        let extraClass = fullyTransparent ? "" : " basic-glossy-panel";
        return html2`
    <div class="basic-page-layout" ...${props}>
        ${!isHomePage && html2`
            <nav class="top-nav">
                <h1> ${!isHomePage ? html2`<a class="home-link" href="/" title="Home">home / </a> ` : ""}${title} </h1>
            </nav>
        `}
        <div class="content ${extraClass}">
            <div class="content-inner">
                ${loadingOrChildren}
            </div>
        </div>
        <div class="footer">
            <span class="version-env">
                <a target="_blank" href="/public/${version}/git-log.txt">
                    v.${version ? version : "..."}${environment && environment !== "production" ? ` (${environment})` : ""}
                </a>
            </span>
            <span class="tos">
                <a href="/home/terms" target="_blank">Legal</a>
            </span>
        </div>
    </div>
    `;
      }, "BasicPageLayout");
      BasicPageLayout_default = BasicPageLayout;
    }
  });

  // bips/Button.js
  var html3, Button, Button_default;
  var init_Button = __esm({
    "bips/Button.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_Loading();
      html3 = htm_module_default.bind(_);
      Button = /* @__PURE__ */ __name(({ variant = "default", onClick, children, loading, bottom, ...props }) => {
        let disabledStyle = "";
        if (props.disabled) {
          disabledStyle = "bip-button-disabled";
        }
        let loadingStyle = "";
        if (loading) {
          loadingStyle = "bip-button-loading";
        }
        let bottomStyle = "";
        if (bottom) {
          bottomStyle = " bip-button-bottom";
        }
        const onClickHandler = /* @__PURE__ */ __name((e3) => {
          if (props.disabled || loading) {
            e3.preventDefault();
            return;
          }
          if (onClick) {
            onClick(e3);
          }
        }, "onClickHandler");
        return html3`
        <button class="bip-button bip-button-${variant} ${disabledStyle} ${loadingStyle}" onClick=${onClickHandler} ...${props}>
            ${loading ? html3`
                    <span class="bip-button-placeholder">${children} <!-- this is what keeps the button the same size when loading --></span>
                    <${Loading_default} size=${12} strokeWidth=${4} />
                ` : children}
        </button>
    `;
      }, "Button");
      Button_default = Button;
    }
  });

  // bips/Flexstack.js
  var html4, Flexstack, Flexstack_default;
  var init_Flexstack = __esm({
    "bips/Flexstack.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      html4 = htm_module_default.bind(_);
      Flexstack = /* @__PURE__ */ __name(({ children, reverse = false, ...props }) => {
        let styleClass = "bip-flexstack";
        if (reverse) {
          styleClass = "bip-flexstack-reverse";
        }
        let disabledStyle = "";
        if (props.disabled) {
          disabledStyle = "bip-button-disabled";
        }
        return html4`
        <div class="${styleClass} ${disabledStyle}">
            ${children}
        </div>
    `;
      }, "Flexstack");
      Flexstack_default = Flexstack;
    }
  });

  // bips/ButtonFrame.js
  var html5, ButtonFrame, ButtonFrame_default;
  var init_ButtonFrame = __esm({
    "bips/ButtonFrame.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_Button();
      html5 = htm_module_default.bind(_);
      ButtonFrame = /* @__PURE__ */ __name(({ type, variant = "default", loading, onClick, label, children, ...props }) => {
        let disabledStyle = "";
        if (props.disabled) {
          disabledStyle = "bip-button-disabled";
        }
        return html5`
        <div class="bip-button-frame bip-button-frame-${variant} ${disabledStyle}">
            <!-- describe what this button does -->
            <div class="bip-button-frame-description">
                ${children}
            </div>
            <${Button_default} bottom type=${type} variant=${variant} loading=${loading} onClick=${onClick} ...${props}>
                ${label}
            <//>
        </div>
    `;
      }, "ButtonFrame");
      ButtonFrame_default = ButtonFrame;
    }
  });

  // bips/Toast/ToastContext.js
  var ToastContext, useToast;
  var init_ToastContext = __esm({
    "bips/Toast/ToastContext.js"() {
      init_preact_module();
      init_hooks_module();
      ToastContext = J(() => {
        console.warn("ToastContext not provided");
        return;
      });
      useToast = /* @__PURE__ */ __name(() => x2(ToastContext), "useToast");
    }
  });

  // node_modules/marked/lib/marked.esm.js
  function _getDefaults() {
    return {
      async: false,
      breaks: false,
      extensions: null,
      gfm: true,
      hooks: null,
      pedantic: false,
      renderer: null,
      silent: false,
      tokenizer: null,
      walkTokens: null
    };
  }
  function changeDefaults(newDefaults) {
    _defaults = newDefaults;
  }
  function edit(regex, opt = "") {
    let source = typeof regex === "string" ? regex : regex.source;
    const obj = {
      replace: /* @__PURE__ */ __name((name, val) => {
        let valSource = typeof val === "string" ? val : val.source;
        valSource = valSource.replace(other.caret, "$1");
        source = source.replace(name, valSource);
        return obj;
      }, "replace"),
      getRegex: /* @__PURE__ */ __name(() => {
        return new RegExp(source, opt);
      }, "getRegex")
    };
    return obj;
  }
  function escape(html57, encode) {
    if (encode) {
      if (other.escapeTest.test(html57)) {
        return html57.replace(other.escapeReplace, getEscapeReplacement);
      }
    } else {
      if (other.escapeTestNoEncode.test(html57)) {
        return html57.replace(other.escapeReplaceNoEncode, getEscapeReplacement);
      }
    }
    return html57;
  }
  function cleanUrl(href) {
    try {
      href = encodeURI(href).replace(other.percentDecode, "%");
    } catch {
      return null;
    }
    return href;
  }
  function splitCells(tableRow, count) {
    const row = tableRow.replace(other.findPipe, (match, offset, str) => {
      let escaped = false;
      let curr = offset;
      while (--curr >= 0 && str[curr] === "\\")
        escaped = !escaped;
      if (escaped) {
        return "|";
      } else {
        return " |";
      }
    }), cells = row.split(other.splitPipe);
    let i3 = 0;
    if (!cells[0].trim()) {
      cells.shift();
    }
    if (cells.length > 0 && !cells.at(-1)?.trim()) {
      cells.pop();
    }
    if (count) {
      if (cells.length > count) {
        cells.splice(count);
      } else {
        while (cells.length < count)
          cells.push("");
      }
    }
    for (; i3 < cells.length; i3++) {
      cells[i3] = cells[i3].trim().replace(other.slashPipe, "|");
    }
    return cells;
  }
  function rtrim(str, c3, invert) {
    const l3 = str.length;
    if (l3 === 0) {
      return "";
    }
    let suffLen = 0;
    while (suffLen < l3) {
      const currChar = str.charAt(l3 - suffLen - 1);
      if (currChar === c3 && true) {
        suffLen++;
      } else {
        break;
      }
    }
    return str.slice(0, l3 - suffLen);
  }
  function findClosingBracket(str, b2) {
    if (str.indexOf(b2[1]) === -1) {
      return -1;
    }
    let level = 0;
    for (let i3 = 0; i3 < str.length; i3++) {
      if (str[i3] === "\\") {
        i3++;
      } else if (str[i3] === b2[0]) {
        level++;
      } else if (str[i3] === b2[1]) {
        level--;
        if (level < 0) {
          return i3;
        }
      }
    }
    return -1;
  }
  function outputLink(cap, link2, raw, lexer2, rules) {
    const href = link2.href;
    const title = link2.title || null;
    const text = cap[1].replace(rules.other.outputLinkReplace, "$1");
    if (cap[0].charAt(0) !== "!") {
      lexer2.state.inLink = true;
      const token = {
        type: "link",
        raw,
        href,
        title,
        text,
        tokens: lexer2.inlineTokens(text)
      };
      lexer2.state.inLink = false;
      return token;
    }
    return {
      type: "image",
      raw,
      href,
      title,
      text
    };
  }
  function indentCodeCompensation(raw, text, rules) {
    const matchIndentToCode = raw.match(rules.other.indentCodeCompensation);
    if (matchIndentToCode === null) {
      return text;
    }
    const indentToCode = matchIndentToCode[1];
    return text.split("\n").map((node) => {
      const matchIndentInNode = node.match(rules.other.beginningSpace);
      if (matchIndentInNode === null) {
        return node;
      }
      const [indentInNode] = matchIndentInNode;
      if (indentInNode.length >= indentToCode.length) {
        return node.slice(indentToCode.length);
      }
      return node;
    }).join("\n");
  }
  function marked(src, opt) {
    return markedInstance.parse(src, opt);
  }
  var _defaults, noopTest, other, newline, blockCode, fences, hr, heading, bullet, lheadingCore, lheading, lheadingGfm, _paragraph, blockText, _blockLabel, def, list, _tag, _comment, html9, paragraph, blockquote, blockNormal, gfmTable, blockGfm, blockPedantic, escape$1, inlineCode, br, inlineText, _punctuation, _punctuationOrSpace, _notPunctuationOrSpace, punctuation, _punctuationGfmStrongEm, _punctuationOrSpaceGfmStrongEm, _notPunctuationOrSpaceGfmStrongEm, blockSkip, emStrongLDelimCore, emStrongLDelim, emStrongLDelimGfm, emStrongRDelimAstCore, emStrongRDelimAst, emStrongRDelimAstGfm, emStrongRDelimUnd, anyPunctuation, autolink, _inlineComment, tag, _inlineLabel, link, reflink, nolink, reflinkSearch, inlineNormal, inlinePedantic, inlineGfm, inlineBreaks, block, inline, escapeReplacements, getEscapeReplacement, _Tokenizer, _Lexer, _Renderer, _TextRenderer, _Parser, _Hooks, Marked, markedInstance, options, setOptions, use, walkTokens, parseInline, parser, lexer;
  var init_marked_esm = __esm({
    "node_modules/marked/lib/marked.esm.js"() {
      __name(_getDefaults, "_getDefaults");
      _defaults = _getDefaults();
      __name(changeDefaults, "changeDefaults");
      noopTest = { exec: /* @__PURE__ */ __name(() => null, "exec") };
      __name(edit, "edit");
      other = {
        codeRemoveIndent: /^(?: {1,4}| {0,3}\t)/gm,
        outputLinkReplace: /\\([\[\]])/g,
        indentCodeCompensation: /^(\s+)(?:```)/,
        beginningSpace: /^\s+/,
        endingHash: /#$/,
        startingSpaceChar: /^ /,
        endingSpaceChar: / $/,
        nonSpaceChar: /[^ ]/,
        newLineCharGlobal: /\n/g,
        tabCharGlobal: /\t/g,
        multipleSpaceGlobal: /\s+/g,
        blankLine: /^[ \t]*$/,
        doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
        blockquoteStart: /^ {0,3}>/,
        blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g,
        blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
        listReplaceTabs: /^\t+/,
        listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
        listIsTask: /^\[[ xX]\] /,
        listReplaceTask: /^\[[ xX]\] +/,
        anyLine: /\n.*\n/,
        hrefBrackets: /^<(.*)>$/,
        tableDelimiter: /[:|]/,
        tableAlignChars: /^\||\| *$/g,
        tableRowBlankLine: /\n[ \t]*$/,
        tableAlignRight: /^ *-+: *$/,
        tableAlignCenter: /^ *:-+: *$/,
        tableAlignLeft: /^ *:-+ *$/,
        startATag: /^<a /i,
        endATag: /^<\/a>/i,
        startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
        endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
        startAngleBracket: /^</,
        endAngleBracket: />$/,
        pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/,
        unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
        escapeTest: /[&<>"']/,
        escapeReplace: /[&<>"']/g,
        escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
        escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
        unescapeTest: /&(#(?:\d+)|(?:#x[0-9A-Fa-f]+)|(?:\w+));?/ig,
        caret: /(^|[^\[])\^/g,
        percentDecode: /%25/g,
        findPipe: /\|/g,
        splitPipe: / \|/,
        slashPipe: /\\\|/g,
        carriageReturn: /\r\n|\r/g,
        spaceLine: /^ +$/gm,
        notSpaceStart: /^\S*/,
        endingNewline: /\n$/,
        listItemRegex: /* @__PURE__ */ __name((bull) => new RegExp(`^( {0,3}${bull})((?:[	 ][^\\n]*)?(?:\\n|$))`), "listItemRegex"),
        nextBulletRegex: /* @__PURE__ */ __name((indent) => new RegExp(`^ {0,${Math.min(3, indent - 1)}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`), "nextBulletRegex"),
        hrRegex: /* @__PURE__ */ __name((indent) => new RegExp(`^ {0,${Math.min(3, indent - 1)}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`), "hrRegex"),
        fencesBeginRegex: /* @__PURE__ */ __name((indent) => new RegExp(`^ {0,${Math.min(3, indent - 1)}}(?:\`\`\`|~~~)`), "fencesBeginRegex"),
        headingBeginRegex: /* @__PURE__ */ __name((indent) => new RegExp(`^ {0,${Math.min(3, indent - 1)}}#`), "headingBeginRegex"),
        htmlBeginRegex: /* @__PURE__ */ __name((indent) => new RegExp(`^ {0,${Math.min(3, indent - 1)}}<(?:[a-z].*>|!--)`, "i"), "htmlBeginRegex")
      };
      newline = /^(?:[ \t]*(?:\n|$))+/;
      blockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
      fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
      hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
      heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
      bullet = /(?:[*+-]|\d{1,9}[.)])/;
      lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
      lheading = edit(lheadingCore).replace(/bull/g, bullet).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
      lheadingGfm = edit(lheadingCore).replace(/bull/g, bullet).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
      _paragraph = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/;
      blockText = /^[^\n]+/;
      _blockLabel = /(?!\s*\])(?:\\.|[^\[\]\\])+/;
      def = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", _blockLabel).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex();
      list = edit(/^( {0,3}bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g, bullet).getRegex();
      _tag = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
      _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
      html9 = edit("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", _comment).replace("tag", _tag).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
      paragraph = edit(_paragraph).replace("hr", hr).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)]) ").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", _tag).getRegex();
      blockquote = edit(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", paragraph).getRegex();
      blockNormal = {
        blockquote,
        code: blockCode,
        def,
        fences,
        heading,
        hr,
        html: html9,
        lheading,
        list,
        newline,
        paragraph,
        table: noopTest,
        text: blockText
      };
      gfmTable = edit("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", hr).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}	)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)]) ").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", _tag).getRegex();
      blockGfm = {
        ...blockNormal,
        lheading: lheadingGfm,
        table: gfmTable,
        paragraph: edit(_paragraph).replace("hr", hr).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", gfmTable).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)]) ").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", _tag).getRegex()
      };
      blockPedantic = {
        ...blockNormal,
        html: edit(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", _comment).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(),
        def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/,
        heading: /^(#{1,6})(.*)(?:\n+|$)/,
        fences: noopTest,
        // fences not supported
        lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/,
        paragraph: edit(_paragraph).replace("hr", hr).replace("heading", " *#{1,6} *[^\n]").replace("lheading", lheading).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex()
      };
      escape$1 = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
      inlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
      br = /^( {2,}|\\)\n(?!\s*$)/;
      inlineText = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
      _punctuation = /[\p{P}\p{S}]/u;
      _punctuationOrSpace = /[\s\p{P}\p{S}]/u;
      _notPunctuationOrSpace = /[^\s\p{P}\p{S}]/u;
      punctuation = edit(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, _punctuationOrSpace).getRegex();
      _punctuationGfmStrongEm = /(?!~)[\p{P}\p{S}]/u;
      _punctuationOrSpaceGfmStrongEm = /(?!~)[\s\p{P}\p{S}]/u;
      _notPunctuationOrSpaceGfmStrongEm = /(?:[^\s\p{P}\p{S}]|~)/u;
      blockSkip = /\[[^[\]]*?\]\((?:\\.|[^\\\(\)]|\((?:\\.|[^\\\(\)])*\))*\)|`[^`]*?`|<[^<>]*?>/g;
      emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|[^\s*]))|^_+(?:((?!_)punct)|([^\s_]))/;
      emStrongLDelim = edit(emStrongLDelimCore, "u").replace(/punct/g, _punctuation).getRegex();
      emStrongLDelimGfm = edit(emStrongLDelimCore, "u").replace(/punct/g, _punctuationGfmStrongEm).getRegex();
      emStrongRDelimAstCore = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
      emStrongRDelimAst = edit(emStrongRDelimAstCore, "gu").replace(/notPunctSpace/g, _notPunctuationOrSpace).replace(/punctSpace/g, _punctuationOrSpace).replace(/punct/g, _punctuation).getRegex();
      emStrongRDelimAstGfm = edit(emStrongRDelimAstCore, "gu").replace(/notPunctSpace/g, _notPunctuationOrSpaceGfmStrongEm).replace(/punctSpace/g, _punctuationOrSpaceGfmStrongEm).replace(/punct/g, _punctuationGfmStrongEm).getRegex();
      emStrongRDelimUnd = edit("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, _notPunctuationOrSpace).replace(/punctSpace/g, _punctuationOrSpace).replace(/punct/g, _punctuation).getRegex();
      anyPunctuation = edit(/\\(punct)/, "gu").replace(/punct/g, _punctuation).getRegex();
      autolink = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
      _inlineComment = edit(_comment).replace("(?:-->|$)", "-->").getRegex();
      tag = edit("^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", _inlineComment).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
      _inlineLabel = /(?:\[(?:\\.|[^\[\]\\])*\]|\\.|`[^`]*`|[^\[\]\\`])*?/;
      link = edit(/^!?\[(label)\]\(\s*(href)(?:\s+(title))?\s*\)/).replace("label", _inlineLabel).replace("href", /<(?:\\.|[^\n<>\\])+>|[^\s\x00-\x1f]*/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex();
      reflink = edit(/^!?\[(label)\]\[(ref)\]/).replace("label", _inlineLabel).replace("ref", _blockLabel).getRegex();
      nolink = edit(/^!?\[(ref)\](?:\[\])?/).replace("ref", _blockLabel).getRegex();
      reflinkSearch = edit("reflink|nolink(?!\\()", "g").replace("reflink", reflink).replace("nolink", nolink).getRegex();
      inlineNormal = {
        _backpedal: noopTest,
        // only used for GFM url
        anyPunctuation,
        autolink,
        blockSkip,
        br,
        code: inlineCode,
        del: noopTest,
        emStrongLDelim,
        emStrongRDelimAst,
        emStrongRDelimUnd,
        escape: escape$1,
        link,
        nolink,
        punctuation,
        reflink,
        reflinkSearch,
        tag,
        text: inlineText,
        url: noopTest
      };
      inlinePedantic = {
        ...inlineNormal,
        link: edit(/^!?\[(label)\]\((.*?)\)/).replace("label", _inlineLabel).getRegex(),
        reflink: edit(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", _inlineLabel).getRegex()
      };
      inlineGfm = {
        ...inlineNormal,
        emStrongRDelimAst: emStrongRDelimAstGfm,
        emStrongLDelim: emStrongLDelimGfm,
        url: edit(/^((?:ftp|https?):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/, "i").replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(),
        _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
        del: /^(~~?)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/,
        text: /^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|https?:\/\/|ftp:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/
      };
      inlineBreaks = {
        ...inlineGfm,
        br: edit(br).replace("{2,}", "*").getRegex(),
        text: edit(inlineGfm.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex()
      };
      block = {
        normal: blockNormal,
        gfm: blockGfm,
        pedantic: blockPedantic
      };
      inline = {
        normal: inlineNormal,
        gfm: inlineGfm,
        breaks: inlineBreaks,
        pedantic: inlinePedantic
      };
      escapeReplacements = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      };
      getEscapeReplacement = /* @__PURE__ */ __name((ch) => escapeReplacements[ch], "getEscapeReplacement");
      __name(escape, "escape");
      __name(cleanUrl, "cleanUrl");
      __name(splitCells, "splitCells");
      __name(rtrim, "rtrim");
      __name(findClosingBracket, "findClosingBracket");
      __name(outputLink, "outputLink");
      __name(indentCodeCompensation, "indentCodeCompensation");
      _Tokenizer = class {
        static {
          __name(this, "_Tokenizer");
        }
        options;
        rules;
        // set by the lexer
        lexer;
        // set by the lexer
        constructor(options2) {
          this.options = options2 || _defaults;
        }
        space(src) {
          const cap = this.rules.block.newline.exec(src);
          if (cap && cap[0].length > 0) {
            return {
              type: "space",
              raw: cap[0]
            };
          }
        }
        code(src) {
          const cap = this.rules.block.code.exec(src);
          if (cap) {
            const text = cap[0].replace(this.rules.other.codeRemoveIndent, "");
            return {
              type: "code",
              raw: cap[0],
              codeBlockStyle: "indented",
              text: !this.options.pedantic ? rtrim(text, "\n") : text
            };
          }
        }
        fences(src) {
          const cap = this.rules.block.fences.exec(src);
          if (cap) {
            const raw = cap[0];
            const text = indentCodeCompensation(raw, cap[3] || "", this.rules);
            return {
              type: "code",
              raw,
              lang: cap[2] ? cap[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : cap[2],
              text
            };
          }
        }
        heading(src) {
          const cap = this.rules.block.heading.exec(src);
          if (cap) {
            let text = cap[2].trim();
            if (this.rules.other.endingHash.test(text)) {
              const trimmed = rtrim(text, "#");
              if (this.options.pedantic) {
                text = trimmed.trim();
              } else if (!trimmed || this.rules.other.endingSpaceChar.test(trimmed)) {
                text = trimmed.trim();
              }
            }
            return {
              type: "heading",
              raw: cap[0],
              depth: cap[1].length,
              text,
              tokens: this.lexer.inline(text)
            };
          }
        }
        hr(src) {
          const cap = this.rules.block.hr.exec(src);
          if (cap) {
            return {
              type: "hr",
              raw: rtrim(cap[0], "\n")
            };
          }
        }
        blockquote(src) {
          const cap = this.rules.block.blockquote.exec(src);
          if (cap) {
            let lines = rtrim(cap[0], "\n").split("\n");
            let raw = "";
            let text = "";
            const tokens = [];
            while (lines.length > 0) {
              let inBlockquote = false;
              const currentLines = [];
              let i3;
              for (i3 = 0; i3 < lines.length; i3++) {
                if (this.rules.other.blockquoteStart.test(lines[i3])) {
                  currentLines.push(lines[i3]);
                  inBlockquote = true;
                } else if (!inBlockquote) {
                  currentLines.push(lines[i3]);
                } else {
                  break;
                }
              }
              lines = lines.slice(i3);
              const currentRaw = currentLines.join("\n");
              const currentText = currentRaw.replace(this.rules.other.blockquoteSetextReplace, "\n    $1").replace(this.rules.other.blockquoteSetextReplace2, "");
              raw = raw ? `${raw}
${currentRaw}` : currentRaw;
              text = text ? `${text}
${currentText}` : currentText;
              const top = this.lexer.state.top;
              this.lexer.state.top = true;
              this.lexer.blockTokens(currentText, tokens, true);
              this.lexer.state.top = top;
              if (lines.length === 0) {
                break;
              }
              const lastToken = tokens.at(-1);
              if (lastToken?.type === "code") {
                break;
              } else if (lastToken?.type === "blockquote") {
                const oldToken = lastToken;
                const newText = oldToken.raw + "\n" + lines.join("\n");
                const newToken = this.blockquote(newText);
                tokens[tokens.length - 1] = newToken;
                raw = raw.substring(0, raw.length - oldToken.raw.length) + newToken.raw;
                text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
                break;
              } else if (lastToken?.type === "list") {
                const oldToken = lastToken;
                const newText = oldToken.raw + "\n" + lines.join("\n");
                const newToken = this.list(newText);
                tokens[tokens.length - 1] = newToken;
                raw = raw.substring(0, raw.length - lastToken.raw.length) + newToken.raw;
                text = text.substring(0, text.length - oldToken.raw.length) + newToken.raw;
                lines = newText.substring(tokens.at(-1).raw.length).split("\n");
                continue;
              }
            }
            return {
              type: "blockquote",
              raw,
              tokens,
              text
            };
          }
        }
        list(src) {
          let cap = this.rules.block.list.exec(src);
          if (cap) {
            let bull = cap[1].trim();
            const isordered = bull.length > 1;
            const list2 = {
              type: "list",
              raw: "",
              ordered: isordered,
              start: isordered ? +bull.slice(0, -1) : "",
              loose: false,
              items: []
            };
            bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
            if (this.options.pedantic) {
              bull = isordered ? bull : "[*+-]";
            }
            const itemRegex = this.rules.other.listItemRegex(bull);
            let endsWithBlankLine = false;
            while (src) {
              let endEarly = false;
              let raw = "";
              let itemContents = "";
              if (!(cap = itemRegex.exec(src))) {
                break;
              }
              if (this.rules.block.hr.test(src)) {
                break;
              }
              raw = cap[0];
              src = src.substring(raw.length);
              let line = cap[2].split("\n", 1)[0].replace(this.rules.other.listReplaceTabs, (t4) => " ".repeat(3 * t4.length));
              let nextLine = src.split("\n", 1)[0];
              let blankLine = !line.trim();
              let indent = 0;
              if (this.options.pedantic) {
                indent = 2;
                itemContents = line.trimStart();
              } else if (blankLine) {
                indent = cap[1].length + 1;
              } else {
                indent = cap[2].search(this.rules.other.nonSpaceChar);
                indent = indent > 4 ? 1 : indent;
                itemContents = line.slice(indent);
                indent += cap[1].length;
              }
              if (blankLine && this.rules.other.blankLine.test(nextLine)) {
                raw += nextLine + "\n";
                src = src.substring(nextLine.length + 1);
                endEarly = true;
              }
              if (!endEarly) {
                const nextBulletRegex = this.rules.other.nextBulletRegex(indent);
                const hrRegex = this.rules.other.hrRegex(indent);
                const fencesBeginRegex = this.rules.other.fencesBeginRegex(indent);
                const headingBeginRegex = this.rules.other.headingBeginRegex(indent);
                const htmlBeginRegex = this.rules.other.htmlBeginRegex(indent);
                while (src) {
                  const rawLine = src.split("\n", 1)[0];
                  let nextLineWithoutTabs;
                  nextLine = rawLine;
                  if (this.options.pedantic) {
                    nextLine = nextLine.replace(this.rules.other.listReplaceNesting, "  ");
                    nextLineWithoutTabs = nextLine;
                  } else {
                    nextLineWithoutTabs = nextLine.replace(this.rules.other.tabCharGlobal, "    ");
                  }
                  if (fencesBeginRegex.test(nextLine)) {
                    break;
                  }
                  if (headingBeginRegex.test(nextLine)) {
                    break;
                  }
                  if (htmlBeginRegex.test(nextLine)) {
                    break;
                  }
                  if (nextBulletRegex.test(nextLine)) {
                    break;
                  }
                  if (hrRegex.test(nextLine)) {
                    break;
                  }
                  if (nextLineWithoutTabs.search(this.rules.other.nonSpaceChar) >= indent || !nextLine.trim()) {
                    itemContents += "\n" + nextLineWithoutTabs.slice(indent);
                  } else {
                    if (blankLine) {
                      break;
                    }
                    if (line.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4) {
                      break;
                    }
                    if (fencesBeginRegex.test(line)) {
                      break;
                    }
                    if (headingBeginRegex.test(line)) {
                      break;
                    }
                    if (hrRegex.test(line)) {
                      break;
                    }
                    itemContents += "\n" + nextLine;
                  }
                  if (!blankLine && !nextLine.trim()) {
                    blankLine = true;
                  }
                  raw += rawLine + "\n";
                  src = src.substring(rawLine.length + 1);
                  line = nextLineWithoutTabs.slice(indent);
                }
              }
              if (!list2.loose) {
                if (endsWithBlankLine) {
                  list2.loose = true;
                } else if (this.rules.other.doubleBlankLine.test(raw)) {
                  endsWithBlankLine = true;
                }
              }
              let istask = null;
              let ischecked;
              if (this.options.gfm) {
                istask = this.rules.other.listIsTask.exec(itemContents);
                if (istask) {
                  ischecked = istask[0] !== "[ ] ";
                  itemContents = itemContents.replace(this.rules.other.listReplaceTask, "");
                }
              }
              list2.items.push({
                type: "list_item",
                raw,
                task: !!istask,
                checked: ischecked,
                loose: false,
                text: itemContents,
                tokens: []
              });
              list2.raw += raw;
            }
            const lastItem = list2.items.at(-1);
            if (lastItem) {
              lastItem.raw = lastItem.raw.trimEnd();
              lastItem.text = lastItem.text.trimEnd();
            } else {
              return;
            }
            list2.raw = list2.raw.trimEnd();
            for (let i3 = 0; i3 < list2.items.length; i3++) {
              this.lexer.state.top = false;
              list2.items[i3].tokens = this.lexer.blockTokens(list2.items[i3].text, []);
              if (!list2.loose) {
                const spacers = list2.items[i3].tokens.filter((t4) => t4.type === "space");
                const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t4) => this.rules.other.anyLine.test(t4.raw));
                list2.loose = hasMultipleLineBreaks;
              }
            }
            if (list2.loose) {
              for (let i3 = 0; i3 < list2.items.length; i3++) {
                list2.items[i3].loose = true;
              }
            }
            return list2;
          }
        }
        html(src) {
          const cap = this.rules.block.html.exec(src);
          if (cap) {
            const token = {
              type: "html",
              block: true,
              raw: cap[0],
              pre: cap[1] === "pre" || cap[1] === "script" || cap[1] === "style",
              text: cap[0]
            };
            return token;
          }
        }
        def(src) {
          const cap = this.rules.block.def.exec(src);
          if (cap) {
            const tag2 = cap[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal, " ");
            const href = cap[2] ? cap[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "";
            const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : cap[3];
            return {
              type: "def",
              tag: tag2,
              raw: cap[0],
              href,
              title
            };
          }
        }
        table(src) {
          const cap = this.rules.block.table.exec(src);
          if (!cap) {
            return;
          }
          if (!this.rules.other.tableDelimiter.test(cap[2])) {
            return;
          }
          const headers = splitCells(cap[1]);
          const aligns = cap[2].replace(this.rules.other.tableAlignChars, "").split("|");
          const rows = cap[3]?.trim() ? cap[3].replace(this.rules.other.tableRowBlankLine, "").split("\n") : [];
          const item = {
            type: "table",
            raw: cap[0],
            header: [],
            align: [],
            rows: []
          };
          if (headers.length !== aligns.length) {
            return;
          }
          for (const align of aligns) {
            if (this.rules.other.tableAlignRight.test(align)) {
              item.align.push("right");
            } else if (this.rules.other.tableAlignCenter.test(align)) {
              item.align.push("center");
            } else if (this.rules.other.tableAlignLeft.test(align)) {
              item.align.push("left");
            } else {
              item.align.push(null);
            }
          }
          for (let i3 = 0; i3 < headers.length; i3++) {
            item.header.push({
              text: headers[i3],
              tokens: this.lexer.inline(headers[i3]),
              header: true,
              align: item.align[i3]
            });
          }
          for (const row of rows) {
            item.rows.push(splitCells(row, item.header.length).map((cell, i3) => {
              return {
                text: cell,
                tokens: this.lexer.inline(cell),
                header: false,
                align: item.align[i3]
              };
            }));
          }
          return item;
        }
        lheading(src) {
          const cap = this.rules.block.lheading.exec(src);
          if (cap) {
            return {
              type: "heading",
              raw: cap[0],
              depth: cap[2].charAt(0) === "=" ? 1 : 2,
              text: cap[1],
              tokens: this.lexer.inline(cap[1])
            };
          }
        }
        paragraph(src) {
          const cap = this.rules.block.paragraph.exec(src);
          if (cap) {
            const text = cap[1].charAt(cap[1].length - 1) === "\n" ? cap[1].slice(0, -1) : cap[1];
            return {
              type: "paragraph",
              raw: cap[0],
              text,
              tokens: this.lexer.inline(text)
            };
          }
        }
        text(src) {
          const cap = this.rules.block.text.exec(src);
          if (cap) {
            return {
              type: "text",
              raw: cap[0],
              text: cap[0],
              tokens: this.lexer.inline(cap[0])
            };
          }
        }
        escape(src) {
          const cap = this.rules.inline.escape.exec(src);
          if (cap) {
            return {
              type: "escape",
              raw: cap[0],
              text: cap[1]
            };
          }
        }
        tag(src) {
          const cap = this.rules.inline.tag.exec(src);
          if (cap) {
            if (!this.lexer.state.inLink && this.rules.other.startATag.test(cap[0])) {
              this.lexer.state.inLink = true;
            } else if (this.lexer.state.inLink && this.rules.other.endATag.test(cap[0])) {
              this.lexer.state.inLink = false;
            }
            if (!this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(cap[0])) {
              this.lexer.state.inRawBlock = true;
            } else if (this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(cap[0])) {
              this.lexer.state.inRawBlock = false;
            }
            return {
              type: "html",
              raw: cap[0],
              inLink: this.lexer.state.inLink,
              inRawBlock: this.lexer.state.inRawBlock,
              block: false,
              text: cap[0]
            };
          }
        }
        link(src) {
          const cap = this.rules.inline.link.exec(src);
          if (cap) {
            const trimmedUrl = cap[2].trim();
            if (!this.options.pedantic && this.rules.other.startAngleBracket.test(trimmedUrl)) {
              if (!this.rules.other.endAngleBracket.test(trimmedUrl)) {
                return;
              }
              const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), "\\");
              if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) {
                return;
              }
            } else {
              const lastParenIndex = findClosingBracket(cap[2], "()");
              if (lastParenIndex > -1) {
                const start = cap[0].indexOf("!") === 0 ? 5 : 4;
                const linkLen = start + cap[1].length + lastParenIndex;
                cap[2] = cap[2].substring(0, lastParenIndex);
                cap[0] = cap[0].substring(0, linkLen).trim();
                cap[3] = "";
              }
            }
            let href = cap[2];
            let title = "";
            if (this.options.pedantic) {
              const link2 = this.rules.other.pedanticHrefTitle.exec(href);
              if (link2) {
                href = link2[1];
                title = link2[3];
              }
            } else {
              title = cap[3] ? cap[3].slice(1, -1) : "";
            }
            href = href.trim();
            if (this.rules.other.startAngleBracket.test(href)) {
              if (this.options.pedantic && !this.rules.other.endAngleBracket.test(trimmedUrl)) {
                href = href.slice(1);
              } else {
                href = href.slice(1, -1);
              }
            }
            return outputLink(cap, {
              href: href ? href.replace(this.rules.inline.anyPunctuation, "$1") : href,
              title: title ? title.replace(this.rules.inline.anyPunctuation, "$1") : title
            }, cap[0], this.lexer, this.rules);
          }
        }
        reflink(src, links) {
          let cap;
          if ((cap = this.rules.inline.reflink.exec(src)) || (cap = this.rules.inline.nolink.exec(src))) {
            const linkString = (cap[2] || cap[1]).replace(this.rules.other.multipleSpaceGlobal, " ");
            const link2 = links[linkString.toLowerCase()];
            if (!link2) {
              const text = cap[0].charAt(0);
              return {
                type: "text",
                raw: text,
                text
              };
            }
            return outputLink(cap, link2, cap[0], this.lexer, this.rules);
          }
        }
        emStrong(src, maskedSrc, prevChar = "") {
          let match = this.rules.inline.emStrongLDelim.exec(src);
          if (!match)
            return;
          if (match[3] && prevChar.match(this.rules.other.unicodeAlphaNumeric))
            return;
          const nextChar = match[1] || match[2] || "";
          if (!nextChar || !prevChar || this.rules.inline.punctuation.exec(prevChar)) {
            const lLength = [...match[0]].length - 1;
            let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
            const endReg = match[0][0] === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
            endReg.lastIndex = 0;
            maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
            while ((match = endReg.exec(maskedSrc)) != null) {
              rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
              if (!rDelim)
                continue;
              rLength = [...rDelim].length;
              if (match[3] || match[4]) {
                delimTotal += rLength;
                continue;
              } else if (match[5] || match[6]) {
                if (lLength % 3 && !((lLength + rLength) % 3)) {
                  midDelimTotal += rLength;
                  continue;
                }
              }
              delimTotal -= rLength;
              if (delimTotal > 0)
                continue;
              rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
              const lastCharLength = [...match[0]][0].length;
              const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
              if (Math.min(lLength, rLength) % 2) {
                const text2 = raw.slice(1, -1);
                return {
                  type: "em",
                  raw,
                  text: text2,
                  tokens: this.lexer.inlineTokens(text2)
                };
              }
              const text = raw.slice(2, -2);
              return {
                type: "strong",
                raw,
                text,
                tokens: this.lexer.inlineTokens(text)
              };
            }
          }
        }
        codespan(src) {
          const cap = this.rules.inline.code.exec(src);
          if (cap) {
            let text = cap[2].replace(this.rules.other.newLineCharGlobal, " ");
            const hasNonSpaceChars = this.rules.other.nonSpaceChar.test(text);
            const hasSpaceCharsOnBothEnds = this.rules.other.startingSpaceChar.test(text) && this.rules.other.endingSpaceChar.test(text);
            if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
              text = text.substring(1, text.length - 1);
            }
            return {
              type: "codespan",
              raw: cap[0],
              text
            };
          }
        }
        br(src) {
          const cap = this.rules.inline.br.exec(src);
          if (cap) {
            return {
              type: "br",
              raw: cap[0]
            };
          }
        }
        del(src) {
          const cap = this.rules.inline.del.exec(src);
          if (cap) {
            return {
              type: "del",
              raw: cap[0],
              text: cap[2],
              tokens: this.lexer.inlineTokens(cap[2])
            };
          }
        }
        autolink(src) {
          const cap = this.rules.inline.autolink.exec(src);
          if (cap) {
            let text, href;
            if (cap[2] === "@") {
              text = cap[1];
              href = "mailto:" + text;
            } else {
              text = cap[1];
              href = text;
            }
            return {
              type: "link",
              raw: cap[0],
              text,
              href,
              tokens: [
                {
                  type: "text",
                  raw: text,
                  text
                }
              ]
            };
          }
        }
        url(src) {
          let cap;
          if (cap = this.rules.inline.url.exec(src)) {
            let text, href;
            if (cap[2] === "@") {
              text = cap[0];
              href = "mailto:" + text;
            } else {
              let prevCapZero;
              do {
                prevCapZero = cap[0];
                cap[0] = this.rules.inline._backpedal.exec(cap[0])?.[0] ?? "";
              } while (prevCapZero !== cap[0]);
              text = cap[0];
              if (cap[1] === "www.") {
                href = "http://" + cap[0];
              } else {
                href = cap[0];
              }
            }
            return {
              type: "link",
              raw: cap[0],
              text,
              href,
              tokens: [
                {
                  type: "text",
                  raw: text,
                  text
                }
              ]
            };
          }
        }
        inlineText(src) {
          const cap = this.rules.inline.text.exec(src);
          if (cap) {
            const escaped = this.lexer.state.inRawBlock;
            return {
              type: "text",
              raw: cap[0],
              text: cap[0],
              escaped
            };
          }
        }
      };
      _Lexer = class __Lexer {
        static {
          __name(this, "_Lexer");
        }
        tokens;
        options;
        state;
        tokenizer;
        inlineQueue;
        constructor(options2) {
          this.tokens = [];
          this.tokens.links = /* @__PURE__ */ Object.create(null);
          this.options = options2 || _defaults;
          this.options.tokenizer = this.options.tokenizer || new _Tokenizer();
          this.tokenizer = this.options.tokenizer;
          this.tokenizer.options = this.options;
          this.tokenizer.lexer = this;
          this.inlineQueue = [];
          this.state = {
            inLink: false,
            inRawBlock: false,
            top: true
          };
          const rules = {
            other,
            block: block.normal,
            inline: inline.normal
          };
          if (this.options.pedantic) {
            rules.block = block.pedantic;
            rules.inline = inline.pedantic;
          } else if (this.options.gfm) {
            rules.block = block.gfm;
            if (this.options.breaks) {
              rules.inline = inline.breaks;
            } else {
              rules.inline = inline.gfm;
            }
          }
          this.tokenizer.rules = rules;
        }
        /**
         * Expose Rules
         */
        static get rules() {
          return {
            block,
            inline
          };
        }
        /**
         * Static Lex Method
         */
        static lex(src, options2) {
          const lexer2 = new __Lexer(options2);
          return lexer2.lex(src);
        }
        /**
         * Static Lex Inline Method
         */
        static lexInline(src, options2) {
          const lexer2 = new __Lexer(options2);
          return lexer2.inlineTokens(src);
        }
        /**
         * Preprocessing
         */
        lex(src) {
          src = src.replace(other.carriageReturn, "\n");
          this.blockTokens(src, this.tokens);
          for (let i3 = 0; i3 < this.inlineQueue.length; i3++) {
            const next = this.inlineQueue[i3];
            this.inlineTokens(next.src, next.tokens);
          }
          this.inlineQueue = [];
          return this.tokens;
        }
        blockTokens(src, tokens = [], lastParagraphClipped = false) {
          if (this.options.pedantic) {
            src = src.replace(other.tabCharGlobal, "    ").replace(other.spaceLine, "");
          }
          while (src) {
            let token;
            if (this.options.extensions?.block?.some((extTokenizer) => {
              if (token = extTokenizer.call({ lexer: this }, src, tokens)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                return true;
              }
              return false;
            })) {
              continue;
            }
            if (token = this.tokenizer.space(src)) {
              src = src.substring(token.raw.length);
              const lastToken = tokens.at(-1);
              if (token.raw.length === 1 && lastToken !== void 0) {
                lastToken.raw += "\n";
              } else {
                tokens.push(token);
              }
              continue;
            }
            if (token = this.tokenizer.code(src)) {
              src = src.substring(token.raw.length);
              const lastToken = tokens.at(-1);
              if (lastToken?.type === "paragraph" || lastToken?.type === "text") {
                lastToken.raw += "\n" + token.raw;
                lastToken.text += "\n" + token.text;
                this.inlineQueue.at(-1).src = lastToken.text;
              } else {
                tokens.push(token);
              }
              continue;
            }
            if (token = this.tokenizer.fences(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (token = this.tokenizer.heading(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (token = this.tokenizer.hr(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (token = this.tokenizer.blockquote(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (token = this.tokenizer.list(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (token = this.tokenizer.html(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (token = this.tokenizer.def(src)) {
              src = src.substring(token.raw.length);
              const lastToken = tokens.at(-1);
              if (lastToken?.type === "paragraph" || lastToken?.type === "text") {
                lastToken.raw += "\n" + token.raw;
                lastToken.text += "\n" + token.raw;
                this.inlineQueue.at(-1).src = lastToken.text;
              } else if (!this.tokens.links[token.tag]) {
                this.tokens.links[token.tag] = {
                  href: token.href,
                  title: token.title
                };
              }
              continue;
            }
            if (token = this.tokenizer.table(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (token = this.tokenizer.lheading(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            let cutSrc = src;
            if (this.options.extensions?.startBlock) {
              let startIndex = Infinity;
              const tempSrc = src.slice(1);
              let tempStart;
              this.options.extensions.startBlock.forEach((getStartIndex) => {
                tempStart = getStartIndex.call({ lexer: this }, tempSrc);
                if (typeof tempStart === "number" && tempStart >= 0) {
                  startIndex = Math.min(startIndex, tempStart);
                }
              });
              if (startIndex < Infinity && startIndex >= 0) {
                cutSrc = src.substring(0, startIndex + 1);
              }
            }
            if (this.state.top && (token = this.tokenizer.paragraph(cutSrc))) {
              const lastToken = tokens.at(-1);
              if (lastParagraphClipped && lastToken?.type === "paragraph") {
                lastToken.raw += "\n" + token.raw;
                lastToken.text += "\n" + token.text;
                this.inlineQueue.pop();
                this.inlineQueue.at(-1).src = lastToken.text;
              } else {
                tokens.push(token);
              }
              lastParagraphClipped = cutSrc.length !== src.length;
              src = src.substring(token.raw.length);
              continue;
            }
            if (token = this.tokenizer.text(src)) {
              src = src.substring(token.raw.length);
              const lastToken = tokens.at(-1);
              if (lastToken?.type === "text") {
                lastToken.raw += "\n" + token.raw;
                lastToken.text += "\n" + token.text;
                this.inlineQueue.pop();
                this.inlineQueue.at(-1).src = lastToken.text;
              } else {
                tokens.push(token);
              }
              continue;
            }
            if (src) {
              const errMsg = "Infinite loop on byte: " + src.charCodeAt(0);
              if (this.options.silent) {
                console.error(errMsg);
                break;
              } else {
                throw new Error(errMsg);
              }
            }
          }
          this.state.top = true;
          return tokens;
        }
        inline(src, tokens = []) {
          this.inlineQueue.push({ src, tokens });
          return tokens;
        }
        /**
         * Lexing/Compiling
         */
        inlineTokens(src, tokens = []) {
          let maskedSrc = src;
          let match = null;
          if (this.tokens.links) {
            const links = Object.keys(this.tokens.links);
            if (links.length > 0) {
              while ((match = this.tokenizer.rules.inline.reflinkSearch.exec(maskedSrc)) != null) {
                if (links.includes(match[0].slice(match[0].lastIndexOf("[") + 1, -1))) {
                  maskedSrc = maskedSrc.slice(0, match.index) + "[" + "a".repeat(match[0].length - 2) + "]" + maskedSrc.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex);
                }
              }
            }
          }
          while ((match = this.tokenizer.rules.inline.blockSkip.exec(maskedSrc)) != null) {
            maskedSrc = maskedSrc.slice(0, match.index) + "[" + "a".repeat(match[0].length - 2) + "]" + maskedSrc.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);
          }
          while ((match = this.tokenizer.rules.inline.anyPunctuation.exec(maskedSrc)) != null) {
            maskedSrc = maskedSrc.slice(0, match.index) + "++" + maskedSrc.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);
          }
          let keepPrevChar = false;
          let prevChar = "";
          while (src) {
            if (!keepPrevChar) {
              prevChar = "";
            }
            keepPrevChar = false;
            let token;
            if (this.options.extensions?.inline?.some((extTokenizer) => {
              if (token = extTokenizer.call({ lexer: this }, src, tokens)) {
                src = src.substring(token.raw.length);
                tokens.push(token);
                return true;
              }
              return false;
            })) {
              continue;
            }
            if (token = this.tokenizer.escape(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (token = this.tokenizer.tag(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (token = this.tokenizer.link(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (token = this.tokenizer.reflink(src, this.tokens.links)) {
              src = src.substring(token.raw.length);
              const lastToken = tokens.at(-1);
              if (token.type === "text" && lastToken?.type === "text") {
                lastToken.raw += token.raw;
                lastToken.text += token.text;
              } else {
                tokens.push(token);
              }
              continue;
            }
            if (token = this.tokenizer.emStrong(src, maskedSrc, prevChar)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (token = this.tokenizer.codespan(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (token = this.tokenizer.br(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (token = this.tokenizer.del(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (token = this.tokenizer.autolink(src)) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            if (!this.state.inLink && (token = this.tokenizer.url(src))) {
              src = src.substring(token.raw.length);
              tokens.push(token);
              continue;
            }
            let cutSrc = src;
            if (this.options.extensions?.startInline) {
              let startIndex = Infinity;
              const tempSrc = src.slice(1);
              let tempStart;
              this.options.extensions.startInline.forEach((getStartIndex) => {
                tempStart = getStartIndex.call({ lexer: this }, tempSrc);
                if (typeof tempStart === "number" && tempStart >= 0) {
                  startIndex = Math.min(startIndex, tempStart);
                }
              });
              if (startIndex < Infinity && startIndex >= 0) {
                cutSrc = src.substring(0, startIndex + 1);
              }
            }
            if (token = this.tokenizer.inlineText(cutSrc)) {
              src = src.substring(token.raw.length);
              if (token.raw.slice(-1) !== "_") {
                prevChar = token.raw.slice(-1);
              }
              keepPrevChar = true;
              const lastToken = tokens.at(-1);
              if (lastToken?.type === "text") {
                lastToken.raw += token.raw;
                lastToken.text += token.text;
              } else {
                tokens.push(token);
              }
              continue;
            }
            if (src) {
              const errMsg = "Infinite loop on byte: " + src.charCodeAt(0);
              if (this.options.silent) {
                console.error(errMsg);
                break;
              } else {
                throw new Error(errMsg);
              }
            }
          }
          return tokens;
        }
      };
      _Renderer = class {
        static {
          __name(this, "_Renderer");
        }
        options;
        parser;
        // set by the parser
        constructor(options2) {
          this.options = options2 || _defaults;
        }
        space(token) {
          return "";
        }
        code({ text, lang, escaped }) {
          const langString = (lang || "").match(other.notSpaceStart)?.[0];
          const code = text.replace(other.endingNewline, "") + "\n";
          if (!langString) {
            return "<pre><code>" + (escaped ? code : escape(code, true)) + "</code></pre>\n";
          }
          return '<pre><code class="language-' + escape(langString) + '">' + (escaped ? code : escape(code, true)) + "</code></pre>\n";
        }
        blockquote({ tokens }) {
          const body = this.parser.parse(tokens);
          return `<blockquote>
${body}</blockquote>
`;
        }
        html({ text }) {
          return text;
        }
        heading({ tokens, depth }) {
          return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>
`;
        }
        hr(token) {
          return "<hr>\n";
        }
        list(token) {
          const ordered = token.ordered;
          const start = token.start;
          let body = "";
          for (let j4 = 0; j4 < token.items.length; j4++) {
            const item = token.items[j4];
            body += this.listitem(item);
          }
          const type = ordered ? "ol" : "ul";
          const startAttr = ordered && start !== 1 ? ' start="' + start + '"' : "";
          return "<" + type + startAttr + ">\n" + body + "</" + type + ">\n";
        }
        listitem(item) {
          let itemBody = "";
          if (item.task) {
            const checkbox = this.checkbox({ checked: !!item.checked });
            if (item.loose) {
              if (item.tokens[0]?.type === "paragraph") {
                item.tokens[0].text = checkbox + " " + item.tokens[0].text;
                if (item.tokens[0].tokens && item.tokens[0].tokens.length > 0 && item.tokens[0].tokens[0].type === "text") {
                  item.tokens[0].tokens[0].text = checkbox + " " + escape(item.tokens[0].tokens[0].text);
                  item.tokens[0].tokens[0].escaped = true;
                }
              } else {
                item.tokens.unshift({
                  type: "text",
                  raw: checkbox + " ",
                  text: checkbox + " ",
                  escaped: true
                });
              }
            } else {
              itemBody += checkbox + " ";
            }
          }
          itemBody += this.parser.parse(item.tokens, !!item.loose);
          return `<li>${itemBody}</li>
`;
        }
        checkbox({ checked }) {
          return "<input " + (checked ? 'checked="" ' : "") + 'disabled="" type="checkbox">';
        }
        paragraph({ tokens }) {
          return `<p>${this.parser.parseInline(tokens)}</p>
`;
        }
        table(token) {
          let header = "";
          let cell = "";
          for (let j4 = 0; j4 < token.header.length; j4++) {
            cell += this.tablecell(token.header[j4]);
          }
          header += this.tablerow({ text: cell });
          let body = "";
          for (let j4 = 0; j4 < token.rows.length; j4++) {
            const row = token.rows[j4];
            cell = "";
            for (let k4 = 0; k4 < row.length; k4++) {
              cell += this.tablecell(row[k4]);
            }
            body += this.tablerow({ text: cell });
          }
          if (body)
            body = `<tbody>${body}</tbody>`;
          return "<table>\n<thead>\n" + header + "</thead>\n" + body + "</table>\n";
        }
        tablerow({ text }) {
          return `<tr>
${text}</tr>
`;
        }
        tablecell(token) {
          const content = this.parser.parseInline(token.tokens);
          const type = token.header ? "th" : "td";
          const tag2 = token.align ? `<${type} align="${token.align}">` : `<${type}>`;
          return tag2 + content + `</${type}>
`;
        }
        /**
         * span level renderer
         */
        strong({ tokens }) {
          return `<strong>${this.parser.parseInline(tokens)}</strong>`;
        }
        em({ tokens }) {
          return `<em>${this.parser.parseInline(tokens)}</em>`;
        }
        codespan({ text }) {
          return `<code>${escape(text, true)}</code>`;
        }
        br(token) {
          return "<br>";
        }
        del({ tokens }) {
          return `<del>${this.parser.parseInline(tokens)}</del>`;
        }
        link({ href, title, tokens }) {
          const text = this.parser.parseInline(tokens);
          const cleanHref = cleanUrl(href);
          if (cleanHref === null) {
            return text;
          }
          href = cleanHref;
          let out = '<a href="' + href + '"';
          if (title) {
            out += ' title="' + escape(title) + '"';
          }
          out += ">" + text + "</a>";
          return out;
        }
        image({ href, title, text }) {
          const cleanHref = cleanUrl(href);
          if (cleanHref === null) {
            return escape(text);
          }
          href = cleanHref;
          let out = `<img src="${href}" alt="${text}"`;
          if (title) {
            out += ` title="${escape(title)}"`;
          }
          out += ">";
          return out;
        }
        text(token) {
          return "tokens" in token && token.tokens ? this.parser.parseInline(token.tokens) : "escaped" in token && token.escaped ? token.text : escape(token.text);
        }
      };
      _TextRenderer = class {
        static {
          __name(this, "_TextRenderer");
        }
        // no need for block level renderers
        strong({ text }) {
          return text;
        }
        em({ text }) {
          return text;
        }
        codespan({ text }) {
          return text;
        }
        del({ text }) {
          return text;
        }
        html({ text }) {
          return text;
        }
        text({ text }) {
          return text;
        }
        link({ text }) {
          return "" + text;
        }
        image({ text }) {
          return "" + text;
        }
        br() {
          return "";
        }
      };
      _Parser = class __Parser {
        static {
          __name(this, "_Parser");
        }
        options;
        renderer;
        textRenderer;
        constructor(options2) {
          this.options = options2 || _defaults;
          this.options.renderer = this.options.renderer || new _Renderer();
          this.renderer = this.options.renderer;
          this.renderer.options = this.options;
          this.renderer.parser = this;
          this.textRenderer = new _TextRenderer();
        }
        /**
         * Static Parse Method
         */
        static parse(tokens, options2) {
          const parser2 = new __Parser(options2);
          return parser2.parse(tokens);
        }
        /**
         * Static Parse Inline Method
         */
        static parseInline(tokens, options2) {
          const parser2 = new __Parser(options2);
          return parser2.parseInline(tokens);
        }
        /**
         * Parse Loop
         */
        parse(tokens, top = true) {
          let out = "";
          for (let i3 = 0; i3 < tokens.length; i3++) {
            const anyToken = tokens[i3];
            if (this.options.extensions?.renderers?.[anyToken.type]) {
              const genericToken = anyToken;
              const ret = this.options.extensions.renderers[genericToken.type].call({ parser: this }, genericToken);
              if (ret !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "html", "paragraph", "text"].includes(genericToken.type)) {
                out += ret || "";
                continue;
              }
            }
            const token = anyToken;
            switch (token.type) {
              case "space": {
                out += this.renderer.space(token);
                continue;
              }
              case "hr": {
                out += this.renderer.hr(token);
                continue;
              }
              case "heading": {
                out += this.renderer.heading(token);
                continue;
              }
              case "code": {
                out += this.renderer.code(token);
                continue;
              }
              case "table": {
                out += this.renderer.table(token);
                continue;
              }
              case "blockquote": {
                out += this.renderer.blockquote(token);
                continue;
              }
              case "list": {
                out += this.renderer.list(token);
                continue;
              }
              case "html": {
                out += this.renderer.html(token);
                continue;
              }
              case "paragraph": {
                out += this.renderer.paragraph(token);
                continue;
              }
              case "text": {
                let textToken = token;
                let body = this.renderer.text(textToken);
                while (i3 + 1 < tokens.length && tokens[i3 + 1].type === "text") {
                  textToken = tokens[++i3];
                  body += "\n" + this.renderer.text(textToken);
                }
                if (top) {
                  out += this.renderer.paragraph({
                    type: "paragraph",
                    raw: body,
                    text: body,
                    tokens: [{ type: "text", raw: body, text: body, escaped: true }]
                  });
                } else {
                  out += body;
                }
                continue;
              }
              default: {
                const errMsg = 'Token with "' + token.type + '" type was not found.';
                if (this.options.silent) {
                  console.error(errMsg);
                  return "";
                } else {
                  throw new Error(errMsg);
                }
              }
            }
          }
          return out;
        }
        /**
         * Parse Inline Tokens
         */
        parseInline(tokens, renderer = this.renderer) {
          let out = "";
          for (let i3 = 0; i3 < tokens.length; i3++) {
            const anyToken = tokens[i3];
            if (this.options.extensions?.renderers?.[anyToken.type]) {
              const ret = this.options.extensions.renderers[anyToken.type].call({ parser: this }, anyToken);
              if (ret !== false || !["escape", "html", "link", "image", "strong", "em", "codespan", "br", "del", "text"].includes(anyToken.type)) {
                out += ret || "";
                continue;
              }
            }
            const token = anyToken;
            switch (token.type) {
              case "escape": {
                out += renderer.text(token);
                break;
              }
              case "html": {
                out += renderer.html(token);
                break;
              }
              case "link": {
                out += renderer.link(token);
                break;
              }
              case "image": {
                out += renderer.image(token);
                break;
              }
              case "strong": {
                out += renderer.strong(token);
                break;
              }
              case "em": {
                out += renderer.em(token);
                break;
              }
              case "codespan": {
                out += renderer.codespan(token);
                break;
              }
              case "br": {
                out += renderer.br(token);
                break;
              }
              case "del": {
                out += renderer.del(token);
                break;
              }
              case "text": {
                out += renderer.text(token);
                break;
              }
              default: {
                const errMsg = 'Token with "' + token.type + '" type was not found.';
                if (this.options.silent) {
                  console.error(errMsg);
                  return "";
                } else {
                  throw new Error(errMsg);
                }
              }
            }
          }
          return out;
        }
      };
      _Hooks = class {
        static {
          __name(this, "_Hooks");
        }
        options;
        block;
        constructor(options2) {
          this.options = options2 || _defaults;
        }
        static passThroughHooks = /* @__PURE__ */ new Set([
          "preprocess",
          "postprocess",
          "processAllTokens"
        ]);
        /**
         * Process markdown before marked
         */
        preprocess(markdown) {
          return markdown;
        }
        /**
         * Process HTML after marked is finished
         */
        postprocess(html57) {
          return html57;
        }
        /**
         * Process all tokens before walk tokens
         */
        processAllTokens(tokens) {
          return tokens;
        }
        /**
         * Provide function to tokenize markdown
         */
        provideLexer() {
          return this.block ? _Lexer.lex : _Lexer.lexInline;
        }
        /**
         * Provide function to parse tokens
         */
        provideParser() {
          return this.block ? _Parser.parse : _Parser.parseInline;
        }
      };
      Marked = class {
        static {
          __name(this, "Marked");
        }
        defaults = _getDefaults();
        options = this.setOptions;
        parse = this.parseMarkdown(true);
        parseInline = this.parseMarkdown(false);
        Parser = _Parser;
        Renderer = _Renderer;
        TextRenderer = _TextRenderer;
        Lexer = _Lexer;
        Tokenizer = _Tokenizer;
        Hooks = _Hooks;
        constructor(...args) {
          this.use(...args);
        }
        /**
         * Run callback for every token
         */
        walkTokens(tokens, callback) {
          let values = [];
          for (const token of tokens) {
            values = values.concat(callback.call(this, token));
            switch (token.type) {
              case "table": {
                const tableToken = token;
                for (const cell of tableToken.header) {
                  values = values.concat(this.walkTokens(cell.tokens, callback));
                }
                for (const row of tableToken.rows) {
                  for (const cell of row) {
                    values = values.concat(this.walkTokens(cell.tokens, callback));
                  }
                }
                break;
              }
              case "list": {
                const listToken = token;
                values = values.concat(this.walkTokens(listToken.items, callback));
                break;
              }
              default: {
                const genericToken = token;
                if (this.defaults.extensions?.childTokens?.[genericToken.type]) {
                  this.defaults.extensions.childTokens[genericToken.type].forEach((childTokens) => {
                    const tokens2 = genericToken[childTokens].flat(Infinity);
                    values = values.concat(this.walkTokens(tokens2, callback));
                  });
                } else if (genericToken.tokens) {
                  values = values.concat(this.walkTokens(genericToken.tokens, callback));
                }
              }
            }
          }
          return values;
        }
        use(...args) {
          const extensions = this.defaults.extensions || { renderers: {}, childTokens: {} };
          args.forEach((pack) => {
            const opts = { ...pack };
            opts.async = this.defaults.async || opts.async || false;
            if (pack.extensions) {
              pack.extensions.forEach((ext) => {
                if (!ext.name) {
                  throw new Error("extension name required");
                }
                if ("renderer" in ext) {
                  const prevRenderer = extensions.renderers[ext.name];
                  if (prevRenderer) {
                    extensions.renderers[ext.name] = function(...args2) {
                      let ret = ext.renderer.apply(this, args2);
                      if (ret === false) {
                        ret = prevRenderer.apply(this, args2);
                      }
                      return ret;
                    };
                  } else {
                    extensions.renderers[ext.name] = ext.renderer;
                  }
                }
                if ("tokenizer" in ext) {
                  if (!ext.level || ext.level !== "block" && ext.level !== "inline") {
                    throw new Error("extension level must be 'block' or 'inline'");
                  }
                  const extLevel = extensions[ext.level];
                  if (extLevel) {
                    extLevel.unshift(ext.tokenizer);
                  } else {
                    extensions[ext.level] = [ext.tokenizer];
                  }
                  if (ext.start) {
                    if (ext.level === "block") {
                      if (extensions.startBlock) {
                        extensions.startBlock.push(ext.start);
                      } else {
                        extensions.startBlock = [ext.start];
                      }
                    } else if (ext.level === "inline") {
                      if (extensions.startInline) {
                        extensions.startInline.push(ext.start);
                      } else {
                        extensions.startInline = [ext.start];
                      }
                    }
                  }
                }
                if ("childTokens" in ext && ext.childTokens) {
                  extensions.childTokens[ext.name] = ext.childTokens;
                }
              });
              opts.extensions = extensions;
            }
            if (pack.renderer) {
              const renderer = this.defaults.renderer || new _Renderer(this.defaults);
              for (const prop in pack.renderer) {
                if (!(prop in renderer)) {
                  throw new Error(`renderer '${prop}' does not exist`);
                }
                if (["options", "parser"].includes(prop)) {
                  continue;
                }
                const rendererProp = prop;
                const rendererFunc = pack.renderer[rendererProp];
                const prevRenderer = renderer[rendererProp];
                renderer[rendererProp] = (...args2) => {
                  let ret = rendererFunc.apply(renderer, args2);
                  if (ret === false) {
                    ret = prevRenderer.apply(renderer, args2);
                  }
                  return ret || "";
                };
              }
              opts.renderer = renderer;
            }
            if (pack.tokenizer) {
              const tokenizer = this.defaults.tokenizer || new _Tokenizer(this.defaults);
              for (const prop in pack.tokenizer) {
                if (!(prop in tokenizer)) {
                  throw new Error(`tokenizer '${prop}' does not exist`);
                }
                if (["options", "rules", "lexer"].includes(prop)) {
                  continue;
                }
                const tokenizerProp = prop;
                const tokenizerFunc = pack.tokenizer[tokenizerProp];
                const prevTokenizer = tokenizer[tokenizerProp];
                tokenizer[tokenizerProp] = (...args2) => {
                  let ret = tokenizerFunc.apply(tokenizer, args2);
                  if (ret === false) {
                    ret = prevTokenizer.apply(tokenizer, args2);
                  }
                  return ret;
                };
              }
              opts.tokenizer = tokenizer;
            }
            if (pack.hooks) {
              const hooks = this.defaults.hooks || new _Hooks();
              for (const prop in pack.hooks) {
                if (!(prop in hooks)) {
                  throw new Error(`hook '${prop}' does not exist`);
                }
                if (["options", "block"].includes(prop)) {
                  continue;
                }
                const hooksProp = prop;
                const hooksFunc = pack.hooks[hooksProp];
                const prevHook = hooks[hooksProp];
                if (_Hooks.passThroughHooks.has(prop)) {
                  hooks[hooksProp] = (arg) => {
                    if (this.defaults.async) {
                      return Promise.resolve(hooksFunc.call(hooks, arg)).then((ret2) => {
                        return prevHook.call(hooks, ret2);
                      });
                    }
                    const ret = hooksFunc.call(hooks, arg);
                    return prevHook.call(hooks, ret);
                  };
                } else {
                  hooks[hooksProp] = (...args2) => {
                    let ret = hooksFunc.apply(hooks, args2);
                    if (ret === false) {
                      ret = prevHook.apply(hooks, args2);
                    }
                    return ret;
                  };
                }
              }
              opts.hooks = hooks;
            }
            if (pack.walkTokens) {
              const walkTokens2 = this.defaults.walkTokens;
              const packWalktokens = pack.walkTokens;
              opts.walkTokens = function(token) {
                let values = [];
                values.push(packWalktokens.call(this, token));
                if (walkTokens2) {
                  values = values.concat(walkTokens2.call(this, token));
                }
                return values;
              };
            }
            this.defaults = { ...this.defaults, ...opts };
          });
          return this;
        }
        setOptions(opt) {
          this.defaults = { ...this.defaults, ...opt };
          return this;
        }
        lexer(src, options2) {
          return _Lexer.lex(src, options2 ?? this.defaults);
        }
        parser(tokens, options2) {
          return _Parser.parse(tokens, options2 ?? this.defaults);
        }
        parseMarkdown(blockType) {
          const parse = /* @__PURE__ */ __name((src, options2) => {
            const origOpt = { ...options2 };
            const opt = { ...this.defaults, ...origOpt };
            const throwError = this.onError(!!opt.silent, !!opt.async);
            if (this.defaults.async === true && origOpt.async === false) {
              return throwError(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
            }
            if (typeof src === "undefined" || src === null) {
              return throwError(new Error("marked(): input parameter is undefined or null"));
            }
            if (typeof src !== "string") {
              return throwError(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(src) + ", string expected"));
            }
            if (opt.hooks) {
              opt.hooks.options = opt;
              opt.hooks.block = blockType;
            }
            const lexer2 = opt.hooks ? opt.hooks.provideLexer() : blockType ? _Lexer.lex : _Lexer.lexInline;
            const parser2 = opt.hooks ? opt.hooks.provideParser() : blockType ? _Parser.parse : _Parser.parseInline;
            if (opt.async) {
              return Promise.resolve(opt.hooks ? opt.hooks.preprocess(src) : src).then((src2) => lexer2(src2, opt)).then((tokens) => opt.hooks ? opt.hooks.processAllTokens(tokens) : tokens).then((tokens) => opt.walkTokens ? Promise.all(this.walkTokens(tokens, opt.walkTokens)).then(() => tokens) : tokens).then((tokens) => parser2(tokens, opt)).then((html57) => opt.hooks ? opt.hooks.postprocess(html57) : html57).catch(throwError);
            }
            try {
              if (opt.hooks) {
                src = opt.hooks.preprocess(src);
              }
              let tokens = lexer2(src, opt);
              if (opt.hooks) {
                tokens = opt.hooks.processAllTokens(tokens);
              }
              if (opt.walkTokens) {
                this.walkTokens(tokens, opt.walkTokens);
              }
              let html57 = parser2(tokens, opt);
              if (opt.hooks) {
                html57 = opt.hooks.postprocess(html57);
              }
              return html57;
            } catch (e3) {
              return throwError(e3);
            }
          }, "parse");
          return parse;
        }
        onError(silent, async) {
          return (e3) => {
            e3.message += "\nPlease report this to https://github.com/markedjs/marked.";
            if (silent) {
              const msg = "<p>An error occurred:</p><pre>" + escape(e3.message + "", true) + "</pre>";
              if (async) {
                return Promise.resolve(msg);
              }
              return msg;
            }
            if (async) {
              return Promise.reject(e3);
            }
            throw e3;
          };
        }
      };
      markedInstance = new Marked();
      __name(marked, "marked");
      marked.options = marked.setOptions = function(options2) {
        markedInstance.setOptions(options2);
        marked.defaults = markedInstance.defaults;
        changeDefaults(marked.defaults);
        return marked;
      };
      marked.getDefaults = _getDefaults;
      marked.defaults = _defaults;
      marked.use = function(...args) {
        markedInstance.use(...args);
        marked.defaults = markedInstance.defaults;
        changeDefaults(marked.defaults);
        return marked;
      };
      marked.walkTokens = function(tokens, callback) {
        return markedInstance.walkTokens(tokens, callback);
      };
      marked.parseInline = markedInstance.parseInline;
      marked.Parser = _Parser;
      marked.parser = _Parser.parse;
      marked.Renderer = _Renderer;
      marked.TextRenderer = _TextRenderer;
      marked.Lexer = _Lexer;
      marked.lexer = _Lexer.lex;
      marked.Tokenizer = _Tokenizer;
      marked.Hooks = _Hooks;
      marked.parse = marked;
      options = marked.options;
      setOptions = marked.setOptions;
      use = marked.use;
      walkTokens = marked.walkTokens;
      parseInline = marked.parseInline;
      parser = _Parser.parse;
      lexer = _Lexer.lex;
    }
  });

  // pages/AboutPage.js
  var AboutPage_exports = {};
  __export(AboutPage_exports, {
    default: () => AboutPage_default
  });
  var html10, aboutMarkdown, AboutPage, AboutPage_default;
  var init_AboutPage = __esm({
    "pages/AboutPage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_marked_esm();
      init_BasicPageLayout();
      html10 = htm_module_default.bind(_);
      aboutMarkdown = `

# What is groovelet.com?

Hi, I'm [Curtis](https://cube-drone.com)!

(now describe what groovelet.com is: a web game, go into more detail about this)

If you want to reach me, I'm always available at [groovelet@gooble.email](mailto:groovelet@gooble.email).

`;
      AboutPage = /* @__PURE__ */ __name(() => {
        let parsed = marked(aboutMarkdown);
        y2(() => {
          document.title = "About";
        }, []);
        return html10`
    <${BasicPageLayout_default} title="About">
        <div dangerouslySetInnerHTML=${{ __html: parsed }}></div>
    </div>
    `;
      }, "AboutPage");
      AboutPage_default = AboutPage;
    }
  });

  // bips/Collapsibro.js
  var html11, Collapsibro, Collapsibro_default;
  var init_Collapsibro = __esm({
    "bips/Collapsibro.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_lucide_preact();
      html11 = htm_module_default.bind(_);
      Collapsibro = /* @__PURE__ */ __name(({ title, variant = "default", start = "closed", visible, children, ...props }) => {
        let [isOpen, setIsOpen] = d2(start === "open");
        const toggleOpen = /* @__PURE__ */ __name(() => {
          setIsOpen(!isOpen);
        }, "toggleOpen");
        if (visible === false) {
          return null;
        }
        return html11`
        <div class="bip-collapsibro bip-collapsibro-${variant}" ...${props}>
            <a class="bip-collapsibro-title" onClick=${toggleOpen}>
                ${isOpen ? html11`<${ChevronDown} />` : html11`<${CircleChevronDown} />`}
                <span class="bip-collapsibro-title-text">${title}</span>
            </a>
            <div class="bip-collapsibro-content" style="display: ${isOpen ? "block" : "none"};">${children}</div>
        </div>
    `;
      }, "Collapsibro");
      Collapsibro_default = Collapsibro;
    }
  });

  // bips/Alert.js
  var html12, Alert, Alert_default;
  var init_Alert = __esm({
    "bips/Alert.js"() {
      init_preact_module();
      init_htm_module();
      init_lucide_preact();
      html12 = htm_module_default.bind(_);
      Alert = /* @__PURE__ */ __name(({ message, error, title, variant = "error", show = true }) => {
        if (!message || message.length == 0) {
          if (error && error.length > 0) {
            message = error;
            variant = "error";
          } else {
            return null;
          }
        }
        if (!show) {
          return null;
        }
        let icon2 = OctagonAlert;
        if (variant === "error") {
          title = title ?? "Error";
        } else if (variant === "warning") {
          icon2 = TriangleAlert;
          title = title ?? "Warning";
        } else if (variant === "info") {
          icon2 = Info;
          title = title ?? "Info";
        } else if (variant === "success") {
          icon2 = PartyPopper;
          title = title ?? "Success";
        } else if (variant === "null") {
          icon2 = CircleOff;
          title = title ?? "Null";
        } else {
          title = title ?? "Alert";
        }
        return html12`
    <div class="bip-alert bip-alert-${variant}">
        <${icon2} /><br/>
        <strong>${title}</strong><br/>
        ${message}
    </div>
    `;
      }, "Alert");
      Alert_default = Alert;
    }
  });

  // bips/BipSamplePage.js
  var BipSamplePage_exports = {};
  __export(BipSamplePage_exports, {
    default: () => BipSamplePage_default
  });
  var html13, BipSamplePage, BipSamplePage_default;
  var init_BipSamplePage = __esm({
    "bips/BipSamplePage.js"() {
      init_preact_module();
      init_htm_module();
      init_BasicPageLayout();
      init_Collapsibro();
      init_Button();
      init_ButtonFrame();
      init_Alert();
      init_Flexstack();
      html13 = htm_module_default.bind(_);
      BipSamplePage = /* @__PURE__ */ __name(() => {
        return html13`
    <${BasicPageLayout_default} title="Bip Sample Page">

        <h2>Collapsibro</h2>
        <${Collapsibro_default} title="Collapsibro Title">
            <p>This is the content of the Collapsibro.</p>
            <p>You can put any content you want here, including other components.</p>
            <p>Look upon my works, ye mighty, and despair</p>
        <//>

        <${Collapsibro_default} variant="primary" title="Primary Collapsibro">
            <p>This is the content of the Collapsibro.</p>
            <p>You can put any content you want here, including other components.</p>
            <p>Look upon my works, ye mighty, and despair</p>
        <//>

        <${Collapsibro_default} variant="warning" title="Warning Collapsibro">
            <p>This is the content of the Collapsibro.</p>
            <p>You can put any content you want here, including other components.</p>
            <p>Look upon my works, ye mighty, and despair</p>
        <//>

        <${Collapsibro_default} variant="success" title="Success Collapsibro">
            <p>This is the content of the Collapsibro.</p>
            <p>You can put any content you want here, including other components.</p>
            <p>Look upon my works, ye mighty, and despair</p>
        <//>

        <${Collapsibro_default} variant="null" title="Null Collapsibro">
            <p>This is the content of the Collapsibro.</p>
            <p>You can put any content you want here, including other components.</p>
            <p>Look upon my works, ye mighty, and despair</p>
        <//>

        <${Collapsibro_default} title="Matroyshka Collapsibro 1">
            <${Collapsibro_default} title="Matroyshka Collapsibro 2">
                <${Collapsibro_default} title="Matroyshka Collapsibro 3">
                    <${Collapsibro_default} title="Matroyshka Collapsibro 4">
                        Surprise! You found the innermost Collapsibro!
                    <//>
                    <${Collapsibro_default} title="Matroyshka Collapsibro 5">
                        Surprise! You found the innermost Collapsibro!
                    <//>
                <//>
            <//>
        <//>

        <h2>Buttons</h2>

        <${Button_default} title="CLICK MEEEEEE" onClick=${() => alert("Button Clicked!")}>
            Button Text
        <//>
        <${Button_default} title="yay" variant="primary" onClick=${() => alert("Button Clicked!")}>
            Button Text
        <//>
        <${Button_default} title="angery" variant="warning" onClick=${() => alert("Button Clicked!")}>
            Button Text
        <//>
        <${Button_default} title="u can't touch this" variant="primary" disabled onClick=${() => alert("Button Clicked!")}>
            Button Text
        <//>
        <${Button_default} title="yay" variant="success" disabled>
            Button Text
        <//>
        <${Button_default} title="boo" variant="null" disabled>
            Button Text
        <//>
        <${Button_default} loading title="CLICK MEEEEEE" onClick=${() => alert("Button Clicked!")}>
            Button Text
        <//>
        <${Button_default} loading title="yay" variant="primary" onClick=${() => alert("Button Clicked!")}>
            Button Text
        <//>
        <${Button_default} loading title="angery" variant="warning" onClick=${() => alert("Button Clicked!")}>
            Button Text
        <//>
        <${Button_default} loading title="u can't touch this" variant="primary" disabled onClick=${() => alert("Button Clicked!")}>
            Button Text
        <//>
        <${Button_default} loading title="yay" variant="success" disabled>
            Button Text
        <//>
        <${Button_default} loading title="boo" variant="null" disabled>
            Button Text
        <//>


        <h2>Button Frames</h2>
        <${Flexstack_default}>
            <${ButtonFrame_default} title="CLICK MEEEEEE" label="Click Me" onClick=${() => alert("Button Frame Clicked!")}>
                <span>Button Frame Text</span>
            <//>
            <${ButtonFrame_default} title="CLICK MEEEEEE" label="Click Me" variant="warning" onClick=${() => alert("Button Frame Clicked!")}>
                <span>Button Frame Text</span>
            <//>
        <//>
        <${Flexstack_default}>
            <${ButtonFrame_default} title="CLICK MEEEEEE" label="Click Me" variant="success" onClick=${() => alert("Button Frame Clicked!")}>
                <span>Button Frame Text</span>
            <//>
            <${ButtonFrame_default} title="CLICK MEEEEEE" label="Click Me" variant="null" onClick=${() => alert("Button Frame Clicked!")}>
                <span>Button Frame Text</span>
            <//>
        <//>

        <h2>Alerts</h2>
        <${Alert_default} message="hi"/>
        <${Alert_default} title="Oh no!" message="This is an error alert!" variant="error"/>
        <${Alert_default} title="Warning!" message="This is a warning alert!" variant="warning"/>
        <${Alert_default} title="Info" message="This is an info alert!" variant="info"/>
        <${Alert_default} title="Success" message="This is a success alert!" variant="success"/>
        <${Alert_default} title="Null" message="This is a null alert!" variant="null"/>
    <//>`;
      }, "BipSamplePage");
      BipSamplePage_default = BipSamplePage;
    }
  });

  // bips/Input.js
  var html14, validUuid, Input, Input_default;
  var init_Input = __esm({
    "bips/Input.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      html14 = htm_module_default.bind(_);
      validUuid = /* @__PURE__ */ __name((value) => {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
      }, "validUuid");
      Input = /* @__PURE__ */ __name(({
        type = "input",
        // Can be 'text', 'email', 'password', 'tel', 'uuid', 'vercode', etc.
        required = false,
        // If true, the input is required
        variant = "default",
        // Can be 'default', 'primary', 'warning', 'null', etc.
        successText = "Nice!",
        // Text to show when the input is valid
        regex,
        // Optional regex for validation
        hideHelpText = false,
        // If true, hides the help text
        onChange,
        // Callback for when the input changes
        onValid,
        // Callback for when the input has changed, and is valid
        onInvalid,
        // Callback for when the input has changed, and is invalid
        children,
        // Label or placeholder text
        value = "",
        ...props
      }) => {
        let [error, setError] = d2(null);
        let [success, setSuccess] = d2(null);
        y2(() => {
          if (success) {
            console.log("Success:", success);
          }
        }, [success]);
        y2(() => {
          if (error) {
            console.log("Error:", error);
          }
        }, [error]);
        let disabledStyle = "";
        if (props.disabled) {
          disabledStyle = "bip-input-disabled";
        }
        let id = props.id || children?.replace(/\s+/g, "-").toLowerCase();
        let label = props.label || children;
        if (required) {
          label += " *";
        }
        let currentDebouncedCallback = null;
        const onChangeDebounced = /* @__PURE__ */ __name((e3) => {
          if (currentDebouncedCallback) {
            clearTimeout(currentDebouncedCallback);
          }
          currentDebouncedCallback = setTimeout(() => {
            onChangeInner(e3);
          }, 400);
        }, "onChangeDebounced");
        const onChangeInner = /* @__PURE__ */ __name((e3) => {
          let inputValue = e3.target.value;
          if (inputValue == null || inputValue == "") {
            inputValue = null;
          }
          console.log("Type: ", type, "Value:", inputValue);
          if (required && inputValue == null) {
            setSuccess(false);
            setError("This field is required");
            e3.valid = false;
          } else if (inputValue == null) {
            console.dir("Input cleared");
            setSuccess(false);
            setError(null);
            e3.valid = false;
          } else if (type === "text" && regex && !new RegExp(regex).test(inputValue)) {
            setSuccess(false);
            setError(`Input does not match the required pattern: ${regex}`);
            e3.valid = false;
          } else if (type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inputValue)) {
            setSuccess(false);
            setError("A valid email address looks like this: valid-email-address@example.org");
            e3.valid = false;
          } else if (type === "tel" && !/^[0-9 +-]+$/.test(inputValue)) {
            setSuccess(false);
            setError("A valid phone number contains only numbers, spaces, and dashes");
            e3.valid = false;
          } else if (type === "tel" && inputValue.replace(/\D/g, "").length < 10) {
            setSuccess(false);
            setError("A valid phone number is at least 10 numbers long");
            e3.valid = false;
          } else if (type === "email_or_tel" && !(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inputValue) || /^[0-9 +-]+$/.test(inputValue))) {
            setSuccess(false);
            setError("That doesn't look like a valid email address or phone number");
            e3.valid = false;
          } else if (type === "password" && inputValue.length < 8) {
            setSuccess(false);
            setError("A valid password is at least 8 characters long");
            e3.valid = false;
          } else if (type === "password" && inputValue === "password") {
            setSuccess(false);
            setError("That is just a dogshit password, try something else");
            e3.valid = false;
          } else if (type === "password" && inputValue === "password1") {
            setSuccess(false);
            setError("Oh, sure, you think you are so clever, huh? Try something else");
            e3.valid = false;
          } else if (type === "password" && inputValue === "password2") {
            setSuccess(false);
            setError("That is also a bad password, try something else.");
            e3.valid = false;
          } else if (type === "password" && inputValue === "password11") {
            setSuccess(false);
            setError("That is not going to work either, try something else");
            e3.valid = false;
          } else if (type === "password" && inputValue.includes("password") && inputValue.length < 12) {
            setSuccess(false);
            setError("You can do better than that, try something else");
            e3.valid = false;
          } else if (type === "password" && inputValue === "12345678") {
            setSuccess(false);
            setError("That's the kind of password an idiot would have on his luggage. Try something else.");
            e3.valid = false;
          } else if (type === "uuid" && inputValue.length !== 36) {
            setSuccess(false);
            setError("A valid UUID is 36 characters long");
            e3.valid = false;
          } else if (type === "uuid" && !validUuid(inputValue)) {
            setSuccess(false);
            setError("A valid UUID looks like this: 123e4567-e89b-12d3-a456-426614174000");
            e3.valid = false;
          } else if (type === "vercode" && !/^\d{6}$/.test(inputValue)) {
            setSuccess(false);
            setError("A valid verification code is a 6-digit number");
            e3.valid = false;
          } else {
            console.log("Input valid");
            setSuccess(true);
            setError(null);
            e3.valid = true;
          }
          if (e3.valid) {
            onValid?.(e3);
          } else {
            onInvalid?.(e3);
          }
          onChange?.(e3);
        }, "onChangeInner");
        let actualType = type;
        if (type === "uuid") {
          actualType = "input";
        }
        ;
        if (type === "vercode") {
          actualType = "number";
        }
        if (type === "email_or_tel") {
          actualType = "text";
        }
        let helpText = "";
        if (props.helpText != null) {
          helpText = html14`<br/><span class="bip-input-help-text">${props.helpText}</span>`;
        }
        let errorStyle = "";
        if (error) {
          errorStyle = "bip-input-error";
          helpText = html14`<br/><span class="bip-input-error-text">${error}</span>`;
        }
        let successStyle = "";
        if (success) {
          successStyle = "bip-input-success";
          if (helpText && helpText != "") {
            helpText = html14`<br/><span class="bip-input-success-text">${successText}</span>`;
          }
        }
        if (hideHelpText) {
          helpText = "";
        }
        return html14`
        <div class="bip-input-group">
            <label for=${id} class="bip-input-label bip-input-label-${variant} ${disabledStyle}">
                ${label}
            </label>
            <br/>
            <input
                type=${actualType}
                defaultValue=${value}
                class="bip-input bip-input-${variant} ${disabledStyle} ${errorStyle} ${successStyle}"
                onChange=${onChangeDebounced}
                ...${props} />
            ${helpText}
        </div>
    `;
      }, "Input");
      Input_default = Input;
    }
  });

  // bips/Checkbox.js
  var html15, Checkbox, Checkbox_default;
  var init_Checkbox = __esm({
    "bips/Checkbox.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      html15 = htm_module_default.bind(_);
      Checkbox = /* @__PURE__ */ __name(({ variant, onChange, children, ...props }) => {
        let disabledStyle = "";
        if (props.disabled) {
          disabledStyle = "bip-checkbox-disabled";
        }
        if (props.id == null) {
          if (typeof children !== "string") {
            props.id = children.replace(/\s+/g, "-").toLowerCase();
          }
        }
        if (props.label == null) {
          props.label = children;
        }
        return html15`
        <div class="bip-checkbox-group">
            <input type="checkbox" class="bip-checkbox bip-checkbox-${variant} ${disabledStyle}" onChange=${onChange} ...${props} />
            <label for=${props.id} class="bip-checkbox-label bip-checkbox-label-${variant} ${disabledStyle}">
                ${props.label}
            </label>
            ${props.description && html15`<p class="bip-checkbox-description">${props.description}</p>`}
        </div>
    `;
      }, "Checkbox");
      Checkbox_default = Checkbox;
    }
  });

  // pages/CommunityCreatePage.js
  var CommunityCreatePage_exports = {};
  __export(CommunityCreatePage_exports, {
    default: () => CommunityCreatePage_default
  });
  var html16, CommunityCreatePage, CommunityCreatePage_default;
  var init_CommunityCreatePage = __esm({
    "pages/CommunityCreatePage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_Button();
      init_Input();
      init_Checkbox();
      init_BasicPageLayout();
      init_Alert();
      html16 = htm_module_default.bind(_);
      CommunityCreatePage = /* @__PURE__ */ __name(() => {
        let [error, setError] = d2(null);
        let [complete, setComplete] = d2(false);
        let { url, path, query, route } = useLocation();
        let [buttonLoading, setButtonLoading] = d2(false);
        y2(() => {
          document.title = "Create Community";
        }, []);
        const formSubmit = /* @__PURE__ */ __name(async (e3) => {
          setButtonLoading(true);
          e3.preventDefault();
          let form = e3.target;
          let formData = new FormData(form);
          let data = {};
          for (let key2 of formData.keys()) {
            data[key2] = formData.get(key2);
          }
          console.dir(data);
          let email = data["community-email"];
          if (email == "" || email.trim() == "") {
            email = null;
          }
          let phone_number = data["community-phone"];
          if (phone_number == "" || phone_number.trim() == "") {
            phone_number = null;
          }
          let community = {
            community_name: data["community-name"],
            name: data["owner-name"],
            email,
            phone_number,
            password: data["community-password"],
            tos: data["community-terms"] == "on"
          };
          console.dir(community);
          try {
            let created_community = await window.Data.community.createCommunity(community);
            route(`/community/${created_community.community_slug}/verify`);
          } catch (e4) {
            setError(e4.message);
          } finally {
            setButtonLoading(false);
          }
        }, "formSubmit");
        const formTest = /* @__PURE__ */ __name((e3) => {
          console.log("formTest", e3);
          let form = e3.target.closest("form");
          let formData = new FormData(form);
          let data = {};
          for (let key2 of formData.keys()) {
            data[key2] = formData.get(key2);
          }
          let community = {
            community_name: data["community-name"],
            name: data["owner-name"],
            email: data["community-email"],
            phone_number: data["community-phone"],
            password: data["community-password"],
            tos: data["community-terms"] == "on"
          };
          console.dir(community);
          if (!community.tos || !community.community_name || !community.name || !community.password) {
            setComplete(false);
            return;
          }
          if (community.password.length < 8) {
            setComplete(false);
            return;
          }
          if (!community.email && !community.phone_number) {
            setComplete(false);
            return;
          }
          if (community.phone_number) {
            if (community.phone_number.length < 9) {
              setComplete(false);
              return;
            }
            if (!community.phone_number.match(/^[0-9 +-]+$/)) {
              setComplete(false);
              return;
            }
          }
          if (community.email) {
            if (!community.email.includes("@") || !community.email.includes(".")) {
              setComplete(false);
              return;
            }
          }
          setComplete(true);
        }, "formTest");
        return html16`
    <${BasicPageLayout_default} title="Create">

        <form onSubmit=${formSubmit}>
            <${Input_default}
                id="community-name"
                name="community-name"
                label="Community Name"
                placeholder="Very Good Hat Community"
                helpText="This is the name of your community"
                successText="That's a pretty good community name!"
                onChange=${formTest}
                required/>
            <br/>
            <${Input_default}
                id="owner-name"
                name="owner-name"
                label="Community Manager Name"
                placeholder="Owen R."
                helpText="This is your name! You'll manage the community's account."
                successText="I like your name!"
                onChange=${formTest}
                required/>
            <br/>
            <${Input_default}
                type="password"
                id="community-password"
                name="community-password"
                label="Community Password"
                helpText="This password will be used to log in to your community account"
                onChange=${formTest}
                required/>
            <br/>
            <${Checkbox_default}
                id="community-terms"
                name="community-terms"
                onChange=${formTest}
                required>
                    I have read and agree to the <a href="/home/terms">terms and conditions</a>.
                <//>
            <h2> Accounts Must Have an Email <em>or</em> Phone Number </h2>
            <${Input_default}
                type="email"
                id="community-email"
                name="community-email"
                label="Email"
                placeholder="hats@verygood.co"
                helpText="A verification email will be sent to this address"
                onChange=${formTest}
                />
            <br/>
            <${Input_default}
                type="tel"
                id="community-phone"
                name="community-phone"
                label="Phone"
                placeholder="1-604-555-1234"
                helpText="A verification SMS will be sent to this number"
                onChange=${formTest}
                />
            <br/>

            <${Alert_default} message=${error} />

            <${Button_default} loading=${buttonLoading} type="submit" variant="primary" disabled=${!complete}>Create Community<//>
        </form>
    </div>
    `;
      }, "CommunityCreatePage");
      CommunityCreatePage_default = CommunityCreatePage;
    }
  });

  // pages/TermsAndConditions.js
  var TermsAndConditions_exports = {};
  __export(TermsAndConditions_exports, {
    default: () => TermsAndConditions_default
  });
  var html17, termsMarkdown, TermsAndConditions, TermsAndConditions_default;
  var init_TermsAndConditions = __esm({
    "pages/TermsAndConditions.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_marked_esm();
      init_BasicPageLayout();
      html17 = htm_module_default.bind(_);
      termsMarkdown = `

Welcome to our website. By accessing or using this site, you agree to comply with the following Terms of Service, Code of Conduct, and Privacy Policy (collectively, "ToSCoCPP").

We, Cube Drone ([https://cube-drone.com](https://cube-drone.com)), operate this website and reserve the right to modify these terms at any time. Continued use of the site constitutes acceptance of the most current version of this document.

---

## 1. General Terms

1.1 **Agreement to Terms**
By using this site, you agree to all terms within this document, even those that may appear contradictory. If any provision is found to be unenforceable, the remainder of the terms remain valid.

1.2 **Changes to Terms**
These terms may be updated at any time. If significant changes are made, we will attempt to notify you via email if provided. Your continued use of the site signifies acceptance of any updates.

1.3 **Non-Waiver**
Failure to enforce any term does not constitute a waiver of our right to enforce it later.

---

## 2. Code of Conduct

2.1 **Respect and Civility**
Users must engage respectfully. Harassment, hate speech, or abusive behavior will not be tolerated.

2.2 **Age Restrictions**
Users must be at least 13 years old to use the site. Certain content may require users to be 18+.

2.3 **Prohibited Content**
Users may not post illegal, violent, pornographic, or otherwise harmful content. Content featuring minors in an adult context is strictly prohibited.

2.4 **No Impersonation**
Users may not falsely claim affiliation with the site or impersonate others.

2.5 **No Unauthorized Access**
Users may not engage in data scraping, hacking, or automated access without permission.

2.6 **No Copyright Infringement**
Users must only post content they own or have permission to use.

2.7 **Privacy and Personal Information**
Users must respect the privacy of others and not disclose private or confidential information without consent.

2.8 **No Malicious Activities**
The distribution of malware, spyware, or other harmful software is prohibited.

---

## 3. Account Management

3.1 **Non-Transferable Accounts**
User accounts are personal and cannot be sold, shared, or transferred.

3.2 **Account Deletion**
Inactive accounts may be removed after three years. Accounts may also be terminated at our discretion.

---

## 4. Enforcement

4.1 **Investigation and Action**
We reserve the right to investigate violations and take appropriate action, including banning users or reporting illegal activities to authorities.

4.2 **Content Moderation**
We may modify or remove any content that violates these terms.

---

## 5. Liability and Disclaimers

5.1 **Indemnification**
Users agree to indemnify Cube Drone against claims arising from their violation of these terms.

5.2 **No Warranty**
The site is provided "as is" without warranties of any kind.

5.3 **Limitation of Liability**
We are not liable for indirect damages arising from the use of this site.

---

## 6. Governing Law and Disputes

6.1 **Jurisdiction**
These terms are governed by the laws of British Columbia, Canada. Any disputes must be resolved in courts located in British Columbia.

6.2 **No Class Actions**
Users agree to bring disputes individually and waive rights to participate in class actions.

---

## 7. Privacy Policy

7.1 **Data Collection**
We collect minimal user data necessary for site functionality and security.

7.2 **Cookies**
We use cookies to maintain user sessions but do not engage in extensive tracking.

7.3 **Third-Party Links**
We are not responsible for external content linked on our site.

7.4 **Data Retention**
User data is retained as long as necessary for site operation, with inactive accounts being purged after three years.

---

## 8. Termination

8.1 **User Termination**
Users may terminate their accounts at any time. Termination does not affect obligations or rights under these terms.

8.2 **Site Termination**
We reserve the right to terminate or restrict access to the site for any reason.

---

## 9. Restricted Access: Canadian Users Only

### 9.1 Eligibility
Our services are intended solely for residents of Canada. By accessing or using our platform, you confirm that you:
- Are a legal resident of Canada;
- Are physically located in Canada when using our services; and
- Have provided accurate, complete, and current information reflecting your Canadian residency.

### 9.2 Geo-Restrictions & Enforcement
We reserve the right to:
- Block access from non-Canadian IP addresses and restrict usage from outside Canada.
- Require users to verify their Canadian residency through billing information, phone number validation, or other means.
- Terminate accounts that, in our sole discretion, do not comply with these residency requirements.

### 9.3 No Availability Outside Canada
We do not offer or market our services outside Canada. If you are not a Canadian resident, you must not use our services. We disclaim all liability for any use outside Canada and make no representations that our platform complies with non-Canadian laws, including data protection, privacy, or consumer regulations.

### 9.4 Non-Canadian Users & Data Collection
If you are not a Canadian resident but still access our services:
- You acknowledge that you are doing so at your own risk, and
- You agree that Canadian laws (including the Personal Information Protection and Electronic Documents Act (PIPEDA)) govern our handling of your data, not foreign privacy laws such as GDPR, CCPA, or others.

---

By using this site, you acknowledge that you have read, understood, and agreed to these Terms of Service, Code of Conduct, and Privacy Policy.



`;
      TermsAndConditions = /* @__PURE__ */ __name(() => {
        let parsed = marked(termsMarkdown);
        y2(() => {
          document.title = "Terms and Conditions";
        }, []);
        return html17`
    <${BasicPageLayout_default} title="Terms and Conditions">
        <div dangerouslySetInnerHTML=${{ __html: parsed }}></div>
    </div>
    `;
      }, "TermsAndConditions");
      TermsAndConditions_default = TermsAndConditions;
    }
  });

  // widgets/CommunityWidget/CommunityWidget.js
  var html18, CommunityWidget, CommunityWidget_default;
  var init_CommunityWidget = __esm({
    "widgets/CommunityWidget/CommunityWidget.js"() {
      init_preact_module();
      init_hooks_module();
      init_src();
      init_htm_module();
      html18 = htm_module_default.bind(_);
      CommunityWidget = /* @__PURE__ */ __name(({ slug }) => {
        const [error, setError] = d2(null);
        const [loading, setLoading] = d2(true);
        const [community, setCommunity] = d2(null);
        const [loggedIn, setLoggedIn] = d2(false);
        let { url, path, query, route } = useLocation();
        y2(async () => {
          try {
            let community2 = await window.Data.community.getCommunity({ slug });
            setCommunity(community2);
          } catch (e3) {
            setError(e3.message);
          }
          setLoading(false);
          try {
            let touch = !path.includes(`/community/${slug}`);
            let session = await window.Data.session.getSession({ slug, touch });
            if (session) {
              setLoggedIn(true);
            } else {
              setLoggedIn(false);
            }
          } catch (e3) {
            if (e3.message.includes("not valid") || e3.message.includes("found")) {
            } else {
              console.error("Error checking session:", e3.message);
            }
            setLoggedIn(false);
          }
        }, [slug]);
        const isCurrentCommunityPage = url.includes(`/community/${slug}`);
        let communityLink = null;
        if (community && !isCurrentCommunityPage) {
          communityLink = html18`<a href="/community/${community.community_slug}">${community.community_name}</a>`;
        } else if (community) {
          communityLink = html18`<span>${community.community_name}</span>`;
        }
        return html18`
    <div class="community-widget ${loggedIn ? "logged-in" : ""}">
        ${loading ? html18`<p>Loading...</p>` : ""}
        ${error ? html18`<p class="error">${error}</p>` : ""}
        ${community ? html18`
            <h3>${communityLink}</h3>
        ` : ""}
    </div>
    `;
      }, "CommunityWidget");
      CommunityWidget_default = CommunityWidget;
    }
  });

  // bips/Searchbar.js
  var html19, Searchbar, Searchbar_default;
  var init_Searchbar = __esm({
    "bips/Searchbar.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_lucide_preact();
      html19 = htm_module_default.bind(_);
      Searchbar = /* @__PURE__ */ __name(({
        onChange,
        defaultValue = "",
        ...props
      }) => {
        return html19`
        <div class="bip-searchbar-container">
            <input
                type="input"
                defaultValue=${defaultValue}
                class="bip-searchbar" onChange=${onChange} ...${props} />
            <${Search} class="bip-searchbar-icon"/>
        </div>
    `;
      }, "Searchbar");
      Searchbar_default = Searchbar;
    }
  });

  // pages/CommunityFindPage.js
  var CommunityFindPage_exports = {};
  __export(CommunityFindPage_exports, {
    default: () => CommunityFindPage_default
  });
  var html20, CommunityFindPage_default;
  var init_CommunityFindPage = __esm({
    "pages/CommunityFindPage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_BasicPageLayout();
      init_CommunityWidget();
      init_Alert();
      init_Button();
      init_Searchbar();
      html20 = htm_module_default.bind(_);
      CommunityFindPage_default = CommunityFindPage = /* @__PURE__ */ __name(() => {
        let [communities, setCommunities] = d2([]);
        let [search, setSearch] = d2("");
        let [error, setError] = d2(null);
        let [loading, setLoading] = d2(true);
        let [noMore, setNoMore] = d2(false);
        y2(async () => {
          document.title = "Find";
          let activeCommunities = await window.Data.community.getActiveCommunities({ n: 5 });
          let communitySlugs = activeCommunities.map((community) => community.community_slug);
          let communities2 = await Promise.all(communitySlugs.map(async (community_slug) => {
            let community = await window.Data.community.getCommunity({ slug: community_slug });
            return community;
          }));
          communities2 = communities2.filter((community) => community != null);
          communities2 = communities2.filter((community) => community.community_name.toLowerCase().includes(search.toLowerCase()));
          try {
            let resp = await window.Data.community.listCommunities({ prefix: search, n: 12 });
            resp = resp.filter((community) => !communities2.some((c3) => c3.community_slug === community.community_slug));
            setNoMore(resp.length == 0);
            setCommunities([...communities2, ...resp]);
            setLoading(false);
          } catch (e3) {
            setError(e3.message);
            setLoading(false);
          }
        }, [search]);
        const loadMoreCommunities = /* @__PURE__ */ __name(async () => {
          try {
            let resp = await window.Data.community.listCommunities({ prefix: search, offset: communities.length });
            if (resp.length == 0) {
              setNoMore(true);
            } else {
              setCommunities(communities.concat(resp));
            }
          } catch (e3) {
            setError(e3.message);
          }
        }, "loadMoreCommunities");
        return html20`
    <${BasicPageLayout_default} loading=${loading && communities} title="Find Community">
        <div class="community-search-bar">
            <${Searchbar_default} onChange=${(e3) => setSearch(e3.target.value)} defaultValue=${search} />
            <${Alert_default} message=${error} />
        </div>
        <hr />

        <${Alert_default} message=${communities.length == 0 ? "no communities found" : ""} variant="null" />
        ${communities?.map((community) => {
          return html20`
                <${CommunityWidget_default} slug=${community.community_slug} />
            `;
        })}
        ${communities?.length > 0 && !noMore ? html20`
            <${Button_default} onClick=${loadMoreCommunities} class="load-more-button" variant="primary" size="large">
                Load more
            <//>` : ""}

    </div>
    `;
      }, "CommunityFindPage");
    }
  });

  // node_modules/animejs/lib/anime.esm.js
  function getNodeList(v3) {
    const n3 = isStr(v3) ? scope2.root.querySelectorAll(v3) : v3;
    if (n3 instanceof NodeList || n3 instanceof HTMLCollection) return n3;
  }
  function parseTargets(targets) {
    if (isNil(targets)) return (
      /** @type {TargetsArray} */
      []
    );
    if (isArr(targets)) {
      const flattened = targets.flat(Infinity);
      const parsed = [];
      for (let i3 = 0, l3 = flattened.length; i3 < l3; i3++) {
        const item = flattened[i3];
        if (!isNil(item)) {
          const nodeList2 = getNodeList(item);
          if (nodeList2) {
            for (let j4 = 0, jl = nodeList2.length; j4 < jl; j4++) {
              const subItem = nodeList2[j4];
              if (!isNil(subItem)) {
                let isDuplicate = false;
                for (let k4 = 0, kl = parsed.length; k4 < kl; k4++) {
                  if (parsed[k4] === subItem) {
                    isDuplicate = true;
                    break;
                  }
                }
                if (!isDuplicate) {
                  parsed.push(subItem);
                }
              }
            }
          } else {
            let isDuplicate = false;
            for (let j4 = 0, jl = parsed.length; j4 < jl; j4++) {
              if (parsed[j4] === item) {
                isDuplicate = true;
                break;
              }
            }
            if (!isDuplicate) {
              parsed.push(item);
            }
          }
        }
      }
      return parsed;
    }
    if (!isBrowser) return (
      /** @type {JSTargetsArray} */
      [targets]
    );
    const nodeList = getNodeList(targets);
    if (nodeList) return (
      /** @type {DOMTargetsArray} */
      Array.from(nodeList)
    );
    return (
      /** @type {TargetsArray} */
      [targets]
    );
  }
  function registerTargets(targets) {
    const parsedTargetsArray = parseTargets(targets);
    const parsedTargetsLength = parsedTargetsArray.length;
    if (parsedTargetsLength) {
      for (let i3 = 0; i3 < parsedTargetsLength; i3++) {
        const target = parsedTargetsArray[i3];
        if (!target[isRegisteredTargetSymbol]) {
          target[isRegisteredTargetSymbol] = true;
          const isSvgType = isSvg(target);
          const isDom = (
            /** @type {DOMTarget} */
            target.nodeType || isSvgType
          );
          if (isDom) {
            target[isDomSymbol] = true;
            target[isSvgSymbol] = isSvgType;
            target[transformsSymbol] = {};
          }
        }
      }
    }
    return parsedTargetsArray;
  }
  function getTargetValue(targetSelector, propName, unit) {
    const targets = registerTargets(targetSelector);
    if (!targets.length) return;
    const [target] = targets;
    const tweenType = getTweenType(target, propName);
    const normalizePropName = sanitizePropertyName(propName, target, tweenType);
    let originalValue = getOriginalAnimatableValue(target, normalizePropName);
    if (isUnd(unit)) {
      return originalValue;
    } else {
      decomposeRawValue(originalValue, decomposedOriginalValue);
      if (decomposedOriginalValue.t === valueTypes.NUMBER || decomposedOriginalValue.t === valueTypes.UNIT) {
        if (unit === false) {
          return decomposedOriginalValue.n;
        } else {
          const convertedValue = convertValueUnit(
            /** @type {DOMTarget} */
            target,
            decomposedOriginalValue,
            /** @type {String} */
            unit,
            false
          );
          return `${round(convertedValue.n, globals.precision)}${convertedValue.u}`;
        }
      }
    }
  }
  var isBrowser, win, doc, tweenTypes, valueTypes, tickModes, compositionTypes, isRegisteredTargetSymbol, isDomSymbol, isSvgSymbol, transformsSymbol, morphPointsSymbol, proxyTargetSymbol, minValue, maxValue, K2, maxFps, emptyString, shortTransforms, validTransforms, transformsFragmentStrings, noop, hexTestRgx, rgbExecRgx, rgbaExecRgx, hslExecRgx, hslaExecRgx, digitWithExponentRgx, unitsExecRgx, lowerCaseRgx, transformsExecRgx, defaults, scope2, globals, globalVersions, toLowerCase, stringStartsWith, now, isArr, isObj, isNum, isStr, isFnc, isUnd, isNil, isSvg, isHex, isRgb, isHsl, isCol, isKey, parseNumber, pow, sqrt, sin, cos, abs, exp, ceil, floor, asin, max, atan2, PI, _round, clamp, powCache, round, snap, interpolate, random, shuffle, clampInfinity, normalizeTime, cloneArray, mergeObjects, forEachChildren, removeChild, addChild, createRefreshable, Clock, render, tick, additive, addAdditiveAnimation, engineTickMethod, engineCancelMethod, Engine, engine, tickEngine, killEngine, parseInlineTransforms, cssReservedProperties, isValidSVGAttribute, rgbToRgba, hexToRgba, hue2rgb, hslToRgba, convertColorStringValuesToRgbaArray, setValue, getFunctionValue, getTweenType, getCSSValue, getOriginalAnimatableValue, getRelativeValue, createDecomposedValueTargetObject, decomposeRawValue, decomposeTweenValue, decomposedOriginalValue, lookups, getTweenSiblings, addTweenSortMethod, overrideTween, composeTween, removeTweenSliblings, resetTimerProperties, reviveTimer, timerId, Timer, none, calcBezier, binarySubdivide, cubicBezier, steps, linear, irregular, halfPI, doublePI, easeInPower, easeInFunctions, easeTypes, parseEaseString, eases, JSEasesLookups, parseEasings, propertyNamesCache, sanitizePropertyName, angleUnitsMap, convertedValuesCache, convertValueUnit, cleanInlineStyles, fromTargetObject, toTargetObject, toFunctionStore, keyframesTargetArray, fastSetValuesArray, keyObjectTarget, tweenId, keyframes, key, generateKeyframes, JSAnimation, animate, transformsShorthands, commonDefaultPXProperties, WAAPIAnimationsLookups, removeWAAPIAnimation, sync, setTargetValues, removeTargetsFromAnimation, remove2, keepTime, randomPick, roundPad, padStart, padEnd, wrap, mapRange, degToRad, radToDeg, lerp, curry, chain, makeChainable, utils, Animatable, Spring, createSpring, preventDefault, DOMProxy, Transforms, parseDraggableFunctionParameter, zIndex, Draggable, createDraggable, Scope, createScope, segmenter;
  var init_anime_esm = __esm({
    "node_modules/animejs/lib/anime.esm.js"() {
      /**
       * anime.js - ESM
       * @version v4.1.2
       * @author Julian Garnier
       * @license MIT
       * @copyright (c) 2025 Julian Garnier
       * @see https://animejs.com
       */
      isBrowser = typeof window !== "undefined";
      win = isBrowser ? (
        /** @type {Window & {AnimeJS: Array}} */
        /** @type {unknown} */
        window
      ) : null;
      doc = isBrowser ? document : null;
      tweenTypes = {
        OBJECT: 0,
        ATTRIBUTE: 1,
        CSS: 2,
        TRANSFORM: 3,
        CSS_VAR: 4
      };
      valueTypes = {
        NUMBER: 0,
        UNIT: 1,
        COLOR: 2,
        COMPLEX: 3
      };
      tickModes = {
        NONE: 0,
        AUTO: 1,
        FORCE: 2
      };
      compositionTypes = {
        replace: 0,
        none: 1,
        blend: 2
      };
      isRegisteredTargetSymbol = Symbol();
      isDomSymbol = Symbol();
      isSvgSymbol = Symbol();
      transformsSymbol = Symbol();
      morphPointsSymbol = Symbol();
      proxyTargetSymbol = Symbol();
      minValue = 1e-11;
      maxValue = 1e12;
      K2 = 1e3;
      maxFps = 120;
      emptyString = "";
      shortTransforms = /* @__PURE__ */ (() => {
        const map = /* @__PURE__ */ new Map();
        map.set("x", "translateX");
        map.set("y", "translateY");
        map.set("z", "translateZ");
        return map;
      })();
      validTransforms = [
        "translateX",
        "translateY",
        "translateZ",
        "rotate",
        "rotateX",
        "rotateY",
        "rotateZ",
        "scale",
        "scaleX",
        "scaleY",
        "scaleZ",
        "skew",
        "skewX",
        "skewY",
        "perspective",
        "matrix",
        "matrix3d"
      ];
      transformsFragmentStrings = /* @__PURE__ */ validTransforms.reduce((a3, v3) => ({ ...a3, [v3]: v3 + "(" }), {});
      noop = /* @__PURE__ */ __name(() => {
      }, "noop");
      hexTestRgx = /(^#([\da-f]{3}){1,2}$)|(^#([\da-f]{4}){1,2}$)/i;
      rgbExecRgx = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i;
      rgbaExecRgx = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(-?\d+|-?\d*.\d+)\s*\)/i;
      hslExecRgx = /hsl\(\s*(-?\d+|-?\d*.\d+)\s*,\s*(-?\d+|-?\d*.\d+)%\s*,\s*(-?\d+|-?\d*.\d+)%\s*\)/i;
      hslaExecRgx = /hsla\(\s*(-?\d+|-?\d*.\d+)\s*,\s*(-?\d+|-?\d*.\d+)%\s*,\s*(-?\d+|-?\d*.\d+)%\s*,\s*(-?\d+|-?\d*.\d+)\s*\)/i;
      digitWithExponentRgx = /[-+]?\d*\.?\d+(?:e[-+]?\d)?/gi;
      unitsExecRgx = /^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)([a-z]+|%)$/i;
      lowerCaseRgx = /([a-z])([A-Z])/g;
      transformsExecRgx = /(\w+)(\([^)]+\)+)/g;
      defaults = {
        id: null,
        keyframes: null,
        playbackEase: null,
        playbackRate: 1,
        frameRate: maxFps,
        loop: 0,
        reversed: false,
        alternate: false,
        autoplay: true,
        duration: K2,
        delay: 0,
        loopDelay: 0,
        ease: "out(2)",
        composition: compositionTypes.replace,
        modifier: /* @__PURE__ */ __name((v3) => v3, "modifier"),
        onBegin: noop,
        onBeforeUpdate: noop,
        onUpdate: noop,
        onLoop: noop,
        onPause: noop,
        onComplete: noop,
        onRender: noop
      };
      scope2 = {
        /** @type {Scope} */
        current: null,
        /** @type {Document|DOMTarget} */
        root: doc
      };
      globals = {
        /** @type {DefaultsParams} */
        defaults,
        /** @type {Number} */
        precision: 4,
        /** @type {Number} */
        timeScale: 1,
        /** @type {Number} */
        tickThreshold: 200
      };
      globalVersions = { version: "4.1.2", engine: null };
      if (isBrowser) {
        if (!win.AnimeJS) win.AnimeJS = [];
        win.AnimeJS.push(globalVersions);
      }
      toLowerCase = /* @__PURE__ */ __name((str) => str.replace(lowerCaseRgx, "$1-$2").toLowerCase(), "toLowerCase");
      stringStartsWith = /* @__PURE__ */ __name((str, sub) => str.indexOf(sub) === 0, "stringStartsWith");
      now = Date.now;
      isArr = Array.isArray;
      isObj = /* @__PURE__ */ __name((a3) => a3 && a3.constructor === Object, "isObj");
      isNum = /* @__PURE__ */ __name((a3) => typeof a3 === "number" && !isNaN(a3), "isNum");
      isStr = /* @__PURE__ */ __name((a3) => typeof a3 === "string", "isStr");
      isFnc = /* @__PURE__ */ __name((a3) => typeof a3 === "function", "isFnc");
      isUnd = /* @__PURE__ */ __name((a3) => typeof a3 === "undefined", "isUnd");
      isNil = /* @__PURE__ */ __name((a3) => isUnd(a3) || a3 === null, "isNil");
      isSvg = /* @__PURE__ */ __name((a3) => isBrowser && a3 instanceof SVGElement, "isSvg");
      isHex = /* @__PURE__ */ __name((a3) => hexTestRgx.test(a3), "isHex");
      isRgb = /* @__PURE__ */ __name((a3) => stringStartsWith(a3, "rgb"), "isRgb");
      isHsl = /* @__PURE__ */ __name((a3) => stringStartsWith(a3, "hsl"), "isHsl");
      isCol = /* @__PURE__ */ __name((a3) => isHex(a3) || isRgb(a3) || isHsl(a3), "isCol");
      isKey = /* @__PURE__ */ __name((a3) => !globals.defaults.hasOwnProperty(a3), "isKey");
      parseNumber = /* @__PURE__ */ __name((str) => isStr(str) ? parseFloat(
        /** @type {String} */
        str
      ) : (
        /** @type {Number} */
        str
      ), "parseNumber");
      pow = Math.pow;
      sqrt = Math.sqrt;
      sin = Math.sin;
      cos = Math.cos;
      abs = Math.abs;
      exp = Math.exp;
      ceil = Math.ceil;
      floor = Math.floor;
      asin = Math.asin;
      max = Math.max;
      atan2 = Math.atan2;
      PI = Math.PI;
      _round = Math.round;
      clamp = /* @__PURE__ */ __name((v3, min, max2) => v3 < min ? min : v3 > max2 ? max2 : v3, "clamp");
      powCache = {};
      round = /* @__PURE__ */ __name((v3, decimalLength) => {
        if (decimalLength < 0) return v3;
        if (!decimalLength) return _round(v3);
        let p3 = powCache[decimalLength];
        if (!p3) p3 = powCache[decimalLength] = 10 ** decimalLength;
        return _round(v3 * p3) / p3;
      }, "round");
      snap = /* @__PURE__ */ __name((v3, increment) => isArr(increment) ? increment.reduce((closest, cv) => abs(cv - v3) < abs(closest - v3) ? cv : closest) : increment ? _round(v3 / increment) * increment : v3, "snap");
      interpolate = /* @__PURE__ */ __name((start, end, progress) => start + (end - start) * progress, "interpolate");
      random = /* @__PURE__ */ __name((min, max2, decimalLength) => {
        const m3 = 10 ** (decimalLength || 0);
        return floor((Math.random() * (max2 - min + 1 / m3) + min) * m3) / m3;
      }, "random");
      shuffle = /* @__PURE__ */ __name((items) => {
        let m3 = items.length, t4, i3;
        while (m3) {
          i3 = random(0, --m3);
          t4 = items[m3];
          items[m3] = items[i3];
          items[i3] = t4;
        }
        return items;
      }, "shuffle");
      clampInfinity = /* @__PURE__ */ __name((v3) => v3 === Infinity ? maxValue : v3 === -Infinity ? -1e12 : v3, "clampInfinity");
      normalizeTime = /* @__PURE__ */ __name((v3) => v3 <= minValue ? minValue : clampInfinity(round(v3, 11)), "normalizeTime");
      cloneArray = /* @__PURE__ */ __name((a3) => isArr(a3) ? [...a3] : a3, "cloneArray");
      mergeObjects = /* @__PURE__ */ __name((o1, o22) => {
        const merged = (
          /** @type {T & U} */
          { ...o1 }
        );
        for (let p3 in o22) {
          const o1p = (
            /** @type {T & U} */
            o1[p3]
          );
          merged[p3] = isUnd(o1p) ? (
            /** @type {T & U} */
            o22[p3]
          ) : o1p;
        }
        return merged;
      }, "mergeObjects");
      forEachChildren = /* @__PURE__ */ __name((parent, callback, reverse, prevProp = "_prev", nextProp = "_next") => {
        let next = parent._head;
        let adjustedNextProp = nextProp;
        if (reverse) {
          next = parent._tail;
          adjustedNextProp = prevProp;
        }
        while (next) {
          const currentNext = next[adjustedNextProp];
          callback(next);
          next = currentNext;
        }
      }, "forEachChildren");
      removeChild = /* @__PURE__ */ __name((parent, child, prevProp = "_prev", nextProp = "_next") => {
        const prev = child[prevProp];
        const next = child[nextProp];
        prev ? prev[nextProp] = next : parent._head = next;
        next ? next[prevProp] = prev : parent._tail = prev;
        child[prevProp] = null;
        child[nextProp] = null;
      }, "removeChild");
      addChild = /* @__PURE__ */ __name((parent, child, sortMethod, prevProp = "_prev", nextProp = "_next") => {
        let prev = parent._tail;
        while (prev && sortMethod && sortMethod(prev, child)) prev = prev[prevProp];
        const next = prev ? prev[nextProp] : parent._head;
        prev ? prev[nextProp] = child : parent._head = child;
        next ? next[prevProp] = child : parent._tail = child;
        child[prevProp] = prev;
        child[nextProp] = next;
      }, "addChild");
      createRefreshable = /* @__PURE__ */ __name((constructor) => {
        let tracked;
        return (...args) => {
          let currentIteration, currentIterationProgress, reversed, alternate;
          if (tracked) {
            currentIteration = tracked.currentIteration;
            currentIterationProgress = tracked.iterationProgress;
            reversed = tracked.reversed;
            alternate = tracked._alternate;
            tracked.revert();
          }
          const cleanup = constructor(...args);
          if (cleanup && !isFnc(cleanup) && cleanup.revert) tracked = cleanup;
          if (!isUnd(currentIterationProgress)) {
            tracked.currentIteration = currentIteration;
            tracked.iterationProgress = (alternate ? !(currentIteration % 2) ? reversed : !reversed : reversed) ? 1 - currentIterationProgress : currentIterationProgress;
          }
          return cleanup || noop;
        };
      }, "createRefreshable");
      Clock = class {
        static {
          __name(this, "Clock");
        }
        /** @param {Number} [initTime] */
        constructor(initTime = 0) {
          this.deltaTime = 0;
          this._currentTime = initTime;
          this._elapsedTime = initTime;
          this._startTime = initTime;
          this._lastTime = initTime;
          this._scheduledTime = 0;
          this._frameDuration = round(K2 / maxFps, 0);
          this._fps = maxFps;
          this._speed = 1;
          this._hasChildren = false;
          this._head = null;
          this._tail = null;
        }
        get fps() {
          return this._fps;
        }
        set fps(frameRate) {
          const previousFrameDuration = this._frameDuration;
          const fr = +frameRate;
          const fps = fr < minValue ? minValue : fr;
          const frameDuration = round(K2 / fps, 0);
          this._fps = fps;
          this._frameDuration = frameDuration;
          this._scheduledTime += frameDuration - previousFrameDuration;
        }
        get speed() {
          return this._speed;
        }
        set speed(playbackRate) {
          const pbr = +playbackRate;
          this._speed = pbr < minValue ? minValue : pbr;
        }
        /**
         * @param  {Number} time
         * @return {tickModes}
         */
        requestTick(time) {
          const scheduledTime = this._scheduledTime;
          const elapsedTime = this._elapsedTime;
          this._elapsedTime += time - elapsedTime;
          if (elapsedTime < scheduledTime) return tickModes.NONE;
          const frameDuration = this._frameDuration;
          const frameDelta = elapsedTime - scheduledTime;
          this._scheduledTime += frameDelta < frameDuration ? frameDuration : frameDelta;
          return tickModes.AUTO;
        }
        /**
         * @param  {Number} time
         * @return {Number}
         */
        computeDeltaTime(time) {
          const delta = time - this._lastTime;
          this.deltaTime = delta;
          this._lastTime = time;
          return delta;
        }
      };
      render = /* @__PURE__ */ __name((tickable, time, muteCallbacks, internalRender, tickMode) => {
        const parent = tickable.parent;
        const duration = tickable.duration;
        const completed = tickable.completed;
        const iterationDuration = tickable.iterationDuration;
        const iterationCount = tickable.iterationCount;
        const _currentIteration = tickable._currentIteration;
        const _loopDelay = tickable._loopDelay;
        const _reversed = tickable._reversed;
        const _alternate = tickable._alternate;
        const _hasChildren = tickable._hasChildren;
        const tickableDelay = tickable._delay;
        const tickablePrevAbsoluteTime = tickable._currentTime;
        const tickableEndTime = tickableDelay + iterationDuration;
        const tickableAbsoluteTime = time - tickableDelay;
        const tickablePrevTime = clamp(tickablePrevAbsoluteTime, -tickableDelay, duration);
        const tickableCurrentTime = clamp(tickableAbsoluteTime, -tickableDelay, duration);
        const deltaTime = tickableAbsoluteTime - tickablePrevAbsoluteTime;
        const isCurrentTimeAboveZero = tickableCurrentTime > 0;
        const isCurrentTimeEqualOrAboveDuration = tickableCurrentTime >= duration;
        const isSetter = duration <= minValue;
        const forcedTick = tickMode === tickModes.FORCE;
        let isOdd = 0;
        let iterationElapsedTime = tickableAbsoluteTime;
        let hasRendered = 0;
        if (iterationCount > 1) {
          const currentIteration = ~~(tickableCurrentTime / (iterationDuration + (isCurrentTimeEqualOrAboveDuration ? 0 : _loopDelay)));
          tickable._currentIteration = clamp(currentIteration, 0, iterationCount);
          if (isCurrentTimeEqualOrAboveDuration) tickable._currentIteration--;
          isOdd = tickable._currentIteration % 2;
          iterationElapsedTime = tickableCurrentTime % (iterationDuration + _loopDelay) || 0;
        }
        const isReversed = _reversed ^ (_alternate && isOdd);
        const _ease = (
          /** @type {Renderable} */
          tickable._ease
        );
        let iterationTime = isCurrentTimeEqualOrAboveDuration ? isReversed ? 0 : duration : isReversed ? iterationDuration - iterationElapsedTime : iterationElapsedTime;
        if (_ease) iterationTime = iterationDuration * _ease(iterationTime / iterationDuration) || 0;
        const isRunningBackwards = (parent ? parent.backwards : tickableAbsoluteTime < tickablePrevAbsoluteTime) ? !isReversed : !!isReversed;
        tickable._currentTime = tickableAbsoluteTime;
        tickable._iterationTime = iterationTime;
        tickable.backwards = isRunningBackwards;
        if (isCurrentTimeAboveZero && !tickable.began) {
          tickable.began = true;
          if (!muteCallbacks && !(parent && (isRunningBackwards || !parent.began))) {
            tickable.onBegin(
              /** @type {CallbackArgument} */
              tickable
            );
          }
        } else if (tickableAbsoluteTime <= 0) {
          tickable.began = false;
        }
        if (!muteCallbacks && !_hasChildren && isCurrentTimeAboveZero && tickable._currentIteration !== _currentIteration) {
          tickable.onLoop(
            /** @type {CallbackArgument} */
            tickable
          );
        }
        if (forcedTick || tickMode === tickModes.AUTO && (time >= tickableDelay && time <= tickableEndTime || // Normal render
        time <= tickableDelay && tickablePrevTime > tickableDelay || // Playhead is before the animation start time so make sure the animation is at its initial state
        time >= tickableEndTime && tickablePrevTime !== duration) || iterationTime >= tickableEndTime && tickablePrevTime !== duration || iterationTime <= tickableDelay && tickablePrevTime > 0 || time <= tickablePrevTime && tickablePrevTime === duration && completed || // Force a render if a seek occurs on an completed animation
        isCurrentTimeEqualOrAboveDuration && !completed && isSetter) {
          if (isCurrentTimeAboveZero) {
            tickable.computeDeltaTime(tickablePrevTime);
            if (!muteCallbacks) tickable.onBeforeUpdate(
              /** @type {CallbackArgument} */
              tickable
            );
          }
          if (!_hasChildren) {
            const forcedRender = forcedTick || (isRunningBackwards ? deltaTime * -1 : deltaTime) >= globals.tickThreshold;
            const absoluteTime = tickable._offset + (parent ? parent._offset : 0) + tickableDelay + iterationTime;
            let tween = (
              /** @type {Tween} */
              /** @type {JSAnimation} */
              tickable._head
            );
            let tweenTarget;
            let tweenStyle;
            let tweenTargetTransforms;
            let tweenTargetTransformsProperties;
            let tweenTransformsNeedUpdate = 0;
            while (tween) {
              const tweenComposition = tween._composition;
              const tweenCurrentTime = tween._currentTime;
              const tweenChangeDuration = tween._changeDuration;
              const tweenAbsEndTime = tween._absoluteStartTime + tween._changeDuration;
              const tweenNextRep = tween._nextRep;
              const tweenPrevRep = tween._prevRep;
              const tweenHasComposition = tweenComposition !== compositionTypes.none;
              if ((forcedRender || (tweenCurrentTime !== tweenChangeDuration || absoluteTime <= tweenAbsEndTime + (tweenNextRep ? tweenNextRep._delay : 0)) && (tweenCurrentTime !== 0 || absoluteTime >= tween._absoluteStartTime)) && (!tweenHasComposition || !tween._isOverridden && (!tween._isOverlapped || absoluteTime <= tweenAbsEndTime) && (!tweenNextRep || (tweenNextRep._isOverridden || absoluteTime <= tweenNextRep._absoluteStartTime)) && (!tweenPrevRep || (tweenPrevRep._isOverridden || absoluteTime >= tweenPrevRep._absoluteStartTime + tweenPrevRep._changeDuration + tween._delay)))) {
                const tweenNewTime = tween._currentTime = clamp(iterationTime - tween._startTime, 0, tweenChangeDuration);
                const tweenProgress = tween._ease(tweenNewTime / tween._updateDuration);
                const tweenModifier = tween._modifier;
                const tweenValueType = tween._valueType;
                const tweenType = tween._tweenType;
                const tweenIsObject = tweenType === tweenTypes.OBJECT;
                const tweenIsNumber = tweenValueType === valueTypes.NUMBER;
                const tweenPrecision = tweenIsNumber && tweenIsObject || tweenProgress === 0 || tweenProgress === 1 ? -1 : globals.precision;
                let value;
                let number;
                if (tweenIsNumber) {
                  value = number = /** @type {Number} */
                  tweenModifier(round(interpolate(tween._fromNumber, tween._toNumber, tweenProgress), tweenPrecision));
                } else if (tweenValueType === valueTypes.UNIT) {
                  number = /** @type {Number} */
                  tweenModifier(round(interpolate(tween._fromNumber, tween._toNumber, tweenProgress), tweenPrecision));
                  value = `${number}${tween._unit}`;
                } else if (tweenValueType === valueTypes.COLOR) {
                  const fn2 = tween._fromNumbers;
                  const tn2 = tween._toNumbers;
                  const r3 = round(clamp(
                    /** @type {Number} */
                    tweenModifier(interpolate(fn2[0], tn2[0], tweenProgress)),
                    0,
                    255
                  ), 0);
                  const g4 = round(clamp(
                    /** @type {Number} */
                    tweenModifier(interpolate(fn2[1], tn2[1], tweenProgress)),
                    0,
                    255
                  ), 0);
                  const b2 = round(clamp(
                    /** @type {Number} */
                    tweenModifier(interpolate(fn2[2], tn2[2], tweenProgress)),
                    0,
                    255
                  ), 0);
                  const a3 = clamp(
                    /** @type {Number} */
                    tweenModifier(round(interpolate(fn2[3], tn2[3], tweenProgress), tweenPrecision)),
                    0,
                    1
                  );
                  value = `rgba(${r3},${g4},${b2},${a3})`;
                  if (tweenHasComposition) {
                    const ns = tween._numbers;
                    ns[0] = r3;
                    ns[1] = g4;
                    ns[2] = b2;
                    ns[3] = a3;
                  }
                } else if (tweenValueType === valueTypes.COMPLEX) {
                  value = tween._strings[0];
                  for (let j4 = 0, l3 = tween._toNumbers.length; j4 < l3; j4++) {
                    const n3 = (
                      /** @type {Number} */
                      tweenModifier(round(interpolate(tween._fromNumbers[j4], tween._toNumbers[j4], tweenProgress), tweenPrecision))
                    );
                    const s3 = tween._strings[j4 + 1];
                    value += `${s3 ? n3 + s3 : n3}`;
                    if (tweenHasComposition) {
                      tween._numbers[j4] = n3;
                    }
                  }
                }
                if (tweenHasComposition) {
                  tween._number = number;
                }
                if (!internalRender && tweenComposition !== compositionTypes.blend) {
                  const tweenProperty = tween.property;
                  tweenTarget = tween.target;
                  if (tweenIsObject) {
                    tweenTarget[tweenProperty] = value;
                  } else if (tweenType === tweenTypes.ATTRIBUTE) {
                    tweenTarget.setAttribute(
                      tweenProperty,
                      /** @type {String} */
                      value
                    );
                  } else {
                    tweenStyle = /** @type {DOMTarget} */
                    tweenTarget.style;
                    if (tweenType === tweenTypes.TRANSFORM) {
                      if (tweenTarget !== tweenTargetTransforms) {
                        tweenTargetTransforms = tweenTarget;
                        tweenTargetTransformsProperties = tweenTarget[transformsSymbol];
                      }
                      tweenTargetTransformsProperties[tweenProperty] = value;
                      tweenTransformsNeedUpdate = 1;
                    } else if (tweenType === tweenTypes.CSS) {
                      tweenStyle[tweenProperty] = value;
                    } else if (tweenType === tweenTypes.CSS_VAR) {
                      tweenStyle.setProperty(
                        tweenProperty,
                        /** @type {String} */
                        value
                      );
                    }
                  }
                  if (isCurrentTimeAboveZero) hasRendered = 1;
                } else {
                  tween._value = value;
                }
              }
              if (tweenTransformsNeedUpdate && tween._renderTransforms) {
                let str = emptyString;
                for (let key2 in tweenTargetTransformsProperties) {
                  str += `${transformsFragmentStrings[key2]}${tweenTargetTransformsProperties[key2]}) `;
                }
                tweenStyle.transform = str;
                tweenTransformsNeedUpdate = 0;
              }
              tween = tween._next;
            }
            if (!muteCallbacks && hasRendered) {
              tickable.onRender(
                /** @type {JSAnimation} */
                tickable
              );
            }
          }
          if (!muteCallbacks && isCurrentTimeAboveZero) {
            tickable.onUpdate(
              /** @type {CallbackArgument} */
              tickable
            );
          }
        }
        if (parent && isSetter) {
          if (!muteCallbacks && (parent.began && !isRunningBackwards && tickableAbsoluteTime >= duration && !completed || isRunningBackwards && tickableAbsoluteTime <= minValue && completed)) {
            tickable.onComplete(
              /** @type {CallbackArgument} */
              tickable
            );
            tickable.completed = !isRunningBackwards;
          }
        } else if (isCurrentTimeAboveZero && isCurrentTimeEqualOrAboveDuration) {
          if (iterationCount === Infinity) {
            tickable._startTime += tickable.duration;
          } else if (tickable._currentIteration >= iterationCount - 1) {
            tickable.paused = true;
            if (!completed && !_hasChildren) {
              tickable.completed = true;
              if (!muteCallbacks && !(parent && (isRunningBackwards || !parent.began))) {
                tickable.onComplete(
                  /** @type {CallbackArgument} */
                  tickable
                );
                tickable._resolve(
                  /** @type {CallbackArgument} */
                  tickable
                );
              }
            }
          }
        } else {
          tickable.completed = false;
        }
        return hasRendered;
      }, "render");
      tick = /* @__PURE__ */ __name((tickable, time, muteCallbacks, internalRender, tickMode) => {
        const _currentIteration = tickable._currentIteration;
        render(tickable, time, muteCallbacks, internalRender, tickMode);
        if (tickable._hasChildren) {
          const tl = (
            /** @type {Timeline} */
            tickable
          );
          const tlIsRunningBackwards = tl.backwards;
          const tlChildrenTime = internalRender ? time : tl._iterationTime;
          const tlCildrenTickTime = now();
          let tlChildrenHasRendered = 0;
          let tlChildrenHaveCompleted = true;
          if (!internalRender && tl._currentIteration !== _currentIteration) {
            const tlIterationDuration = tl.iterationDuration;
            forEachChildren(tl, (child) => {
              if (!tlIsRunningBackwards) {
                if (!child.completed && !child.backwards && child._currentTime < child.iterationDuration) {
                  render(child, tlIterationDuration, muteCallbacks, 1, tickModes.FORCE);
                }
                child.began = false;
                child.completed = false;
              } else {
                const childDuration = child.duration;
                const childStartTime = child._offset + child._delay;
                const childEndTime = childStartTime + childDuration;
                if (!muteCallbacks && childDuration <= minValue && (!childStartTime || childEndTime === tlIterationDuration)) {
                  child.onComplete(child);
                }
              }
            });
            if (!muteCallbacks) tl.onLoop(
              /** @type {CallbackArgument} */
              tl
            );
          }
          forEachChildren(tl, (child) => {
            const childTime = round((tlChildrenTime - child._offset) * child._speed, 12);
            const childTickMode = child._fps < tl._fps ? child.requestTick(tlCildrenTickTime) : tickMode;
            tlChildrenHasRendered += render(child, childTime, muteCallbacks, internalRender, childTickMode);
            if (!child.completed && tlChildrenHaveCompleted) tlChildrenHaveCompleted = false;
          }, tlIsRunningBackwards);
          if (!muteCallbacks && tlChildrenHasRendered) tl.onRender(
            /** @type {CallbackArgument} */
            tl
          );
          if ((tlChildrenHaveCompleted || tlIsRunningBackwards) && tl._currentTime >= tl.duration) {
            tl.paused = true;
            if (!tl.completed) {
              tl.completed = true;
              if (!muteCallbacks) {
                tl.onComplete(
                  /** @type {CallbackArgument} */
                  tl
                );
                tl._resolve(
                  /** @type {CallbackArgument} */
                  tl
                );
              }
            }
          }
        }
      }, "tick");
      additive = {
        animation: null,
        update: noop
      };
      addAdditiveAnimation = /* @__PURE__ */ __name((lookups2) => {
        let animation = additive.animation;
        if (!animation) {
          animation = {
            duration: minValue,
            computeDeltaTime: noop,
            _offset: 0,
            _delay: 0,
            _head: null,
            _tail: null
          };
          additive.animation = animation;
          additive.update = () => {
            lookups2.forEach((propertyAnimation) => {
              for (let propertyName in propertyAnimation) {
                const tweens = propertyAnimation[propertyName];
                const lookupTween = tweens._head;
                if (lookupTween) {
                  const valueType = lookupTween._valueType;
                  const additiveValues = valueType === valueTypes.COMPLEX || valueType === valueTypes.COLOR ? cloneArray(lookupTween._fromNumbers) : null;
                  let additiveValue = lookupTween._fromNumber;
                  let tween = tweens._tail;
                  while (tween && tween !== lookupTween) {
                    if (additiveValues) {
                      for (let i3 = 0, l3 = tween._numbers.length; i3 < l3; i3++) additiveValues[i3] += tween._numbers[i3];
                    } else {
                      additiveValue += tween._number;
                    }
                    tween = tween._prevAdd;
                  }
                  lookupTween._toNumber = additiveValue;
                  lookupTween._toNumbers = additiveValues;
                }
              }
            });
            render(animation, 1, 1, 0, tickModes.FORCE);
          };
        }
        return animation;
      }, "addAdditiveAnimation");
      engineTickMethod = /* @__PURE__ */ (() => isBrowser ? requestAnimationFrame : setImmediate)();
      engineCancelMethod = /* @__PURE__ */ (() => isBrowser ? cancelAnimationFrame : clearImmediate)();
      Engine = class extends Clock {
        static {
          __name(this, "Engine");
        }
        /** @param {Number} [initTime] */
        constructor(initTime) {
          super(initTime);
          this.useDefaultMainLoop = true;
          this.pauseOnDocumentHidden = true;
          this.defaults = defaults;
          this.paused = isBrowser && doc.hidden ? true : false;
          this.reqId = null;
        }
        update() {
          const time = this._currentTime = now();
          if (this.requestTick(time)) {
            this.computeDeltaTime(time);
            const engineSpeed = this._speed;
            const engineFps = this._fps;
            let activeTickable = (
              /** @type {Tickable} */
              this._head
            );
            while (activeTickable) {
              const nextTickable = activeTickable._next;
              if (!activeTickable.paused) {
                tick(
                  activeTickable,
                  (time - activeTickable._startTime) * activeTickable._speed * engineSpeed,
                  0,
                  // !muteCallbacks
                  0,
                  // !internalRender
                  activeTickable._fps < engineFps ? activeTickable.requestTick(time) : tickModes.AUTO
                );
              } else {
                removeChild(this, activeTickable);
                this._hasChildren = !!this._tail;
                activeTickable._running = false;
                if (activeTickable.completed && !activeTickable._cancelled) {
                  activeTickable.cancel();
                }
              }
              activeTickable = nextTickable;
            }
            additive.update();
          }
        }
        wake() {
          if (this.useDefaultMainLoop && !this.reqId && !this.paused) {
            this.reqId = engineTickMethod(tickEngine);
          }
          return this;
        }
        pause() {
          this.paused = true;
          return killEngine();
        }
        resume() {
          if (!this.paused) return;
          this.paused = false;
          forEachChildren(this, (child) => child.resetTime());
          return this.wake();
        }
        // Getter and setter for speed
        get speed() {
          return this._speed * (globals.timeScale === 1 ? 1 : K2);
        }
        set speed(playbackRate) {
          this._speed = playbackRate * globals.timeScale;
          forEachChildren(this, (child) => child.speed = child._speed);
        }
        // Getter and setter for timeUnit
        get timeUnit() {
          return globals.timeScale === 1 ? "ms" : "s";
        }
        set timeUnit(unit) {
          const secondsScale = 1e-3;
          const isSecond = unit === "s";
          const newScale = isSecond ? secondsScale : 1;
          if (globals.timeScale !== newScale) {
            globals.timeScale = newScale;
            globals.tickThreshold = 200 * newScale;
            const scaleFactor = isSecond ? secondsScale : K2;
            this.defaults.duration *= scaleFactor;
            this._speed *= scaleFactor;
          }
        }
        // Getter and setter for precision
        get precision() {
          return globals.precision;
        }
        set precision(precision) {
          globals.precision = precision;
        }
      };
      engine = /* @__PURE__ */ (() => {
        const engine2 = new Engine(now());
        if (isBrowser) {
          globalVersions.engine = engine2;
          doc.addEventListener("visibilitychange", () => {
            if (!engine2.pauseOnDocumentHidden) return;
            doc.hidden ? engine2.pause() : engine2.resume();
          });
        }
        return engine2;
      })();
      tickEngine = /* @__PURE__ */ __name(() => {
        if (engine._head) {
          engine.reqId = engineTickMethod(tickEngine);
          engine.update();
        } else {
          engine.reqId = 0;
        }
      }, "tickEngine");
      killEngine = /* @__PURE__ */ __name(() => {
        engineCancelMethod(
          /** @type {NodeJS.Immediate & Number} */
          engine.reqId
        );
        engine.reqId = 0;
        return engine;
      }, "killEngine");
      parseInlineTransforms = /* @__PURE__ */ __name((target, propName, animationInlineStyles) => {
        const inlineTransforms = target.style.transform;
        let inlinedStylesPropertyValue;
        if (inlineTransforms) {
          const cachedTransforms = target[transformsSymbol];
          let t4;
          while (t4 = transformsExecRgx.exec(inlineTransforms)) {
            const inlinePropertyName = t4[1];
            const inlinePropertyValue = t4[2].slice(1, -1);
            cachedTransforms[inlinePropertyName] = inlinePropertyValue;
            if (inlinePropertyName === propName) {
              inlinedStylesPropertyValue = inlinePropertyValue;
              if (animationInlineStyles) {
                animationInlineStyles[propName] = inlinePropertyValue;
              }
            }
          }
        }
        return inlineTransforms && !isUnd(inlinedStylesPropertyValue) ? inlinedStylesPropertyValue : stringStartsWith(propName, "scale") ? "1" : stringStartsWith(propName, "rotate") || stringStartsWith(propName, "skew") ? "0deg" : "0px";
      }, "parseInlineTransforms");
      __name(getNodeList, "getNodeList");
      __name(parseTargets, "parseTargets");
      __name(registerTargets, "registerTargets");
      cssReservedProperties = ["opacity", "rotate", "overflow", "color"];
      isValidSVGAttribute = /* @__PURE__ */ __name((el, propertyName) => {
        if (cssReservedProperties.includes(propertyName)) return false;
        if (el.getAttribute(propertyName) || propertyName in el) {
          if (propertyName === "scale") {
            const elParentNode = (
              /** @type {SVGGeometryElement} */
              /** @type {DOMTarget} */
              el.parentNode
            );
            return elParentNode && elParentNode.tagName === "filter";
          }
          return true;
        }
      }, "isValidSVGAttribute");
      rgbToRgba = /* @__PURE__ */ __name((rgbValue) => {
        const rgba = rgbExecRgx.exec(rgbValue) || rgbaExecRgx.exec(rgbValue);
        const a3 = !isUnd(rgba[4]) ? +rgba[4] : 1;
        return [
          +rgba[1],
          +rgba[2],
          +rgba[3],
          a3
        ];
      }, "rgbToRgba");
      hexToRgba = /* @__PURE__ */ __name((hexValue) => {
        const hexLength = hexValue.length;
        const isShort = hexLength === 4 || hexLength === 5;
        return [
          +("0x" + hexValue[1] + hexValue[isShort ? 1 : 2]),
          +("0x" + hexValue[isShort ? 2 : 3] + hexValue[isShort ? 2 : 4]),
          +("0x" + hexValue[isShort ? 3 : 5] + hexValue[isShort ? 3 : 6]),
          hexLength === 5 || hexLength === 9 ? +(+("0x" + hexValue[isShort ? 4 : 7] + hexValue[isShort ? 4 : 8]) / 255).toFixed(3) : 1
        ];
      }, "hexToRgba");
      hue2rgb = /* @__PURE__ */ __name((p3, q4, t4) => {
        if (t4 < 0) t4 += 1;
        if (t4 > 1) t4 -= 1;
        return t4 < 1 / 6 ? p3 + (q4 - p3) * 6 * t4 : t4 < 1 / 2 ? q4 : t4 < 2 / 3 ? p3 + (q4 - p3) * (2 / 3 - t4) * 6 : p3;
      }, "hue2rgb");
      hslToRgba = /* @__PURE__ */ __name((hslValue) => {
        const hsla = hslExecRgx.exec(hslValue) || hslaExecRgx.exec(hslValue);
        const h3 = +hsla[1] / 360;
        const s3 = +hsla[2] / 100;
        const l3 = +hsla[3] / 100;
        const a3 = !isUnd(hsla[4]) ? +hsla[4] : 1;
        let r3, g4, b2;
        if (s3 === 0) {
          r3 = g4 = b2 = l3;
        } else {
          const q4 = l3 < 0.5 ? l3 * (1 + s3) : l3 + s3 - l3 * s3;
          const p3 = 2 * l3 - q4;
          r3 = round(hue2rgb(p3, q4, h3 + 1 / 3) * 255, 0);
          g4 = round(hue2rgb(p3, q4, h3) * 255, 0);
          b2 = round(hue2rgb(p3, q4, h3 - 1 / 3) * 255, 0);
        }
        return [r3, g4, b2, a3];
      }, "hslToRgba");
      convertColorStringValuesToRgbaArray = /* @__PURE__ */ __name((colorString) => {
        return isRgb(colorString) ? rgbToRgba(colorString) : isHex(colorString) ? hexToRgba(colorString) : isHsl(colorString) ? hslToRgba(colorString) : [0, 0, 0, 1];
      }, "convertColorStringValuesToRgbaArray");
      setValue = /* @__PURE__ */ __name((targetValue, defaultValue) => {
        return isUnd(targetValue) ? defaultValue : targetValue;
      }, "setValue");
      getFunctionValue = /* @__PURE__ */ __name((value, target, index, total, store) => {
        if (isFnc(value)) {
          const func = /* @__PURE__ */ __name(() => {
            const computed = (
              /** @type {Function} */
              value(target, index, total)
            );
            return !isNaN(+computed) ? +computed : computed || 0;
          }, "func");
          if (store) {
            store.func = func;
          }
          return func();
        } else {
          return value;
        }
      }, "getFunctionValue");
      getTweenType = /* @__PURE__ */ __name((target, prop) => {
        return !target[isDomSymbol] ? tweenTypes.OBJECT : (
          // Handle SVG attributes
          target[isSvgSymbol] && isValidSVGAttribute(target, prop) ? tweenTypes.ATTRIBUTE : (
            // Handle CSS Transform properties differently than CSS to allow individual animations
            validTransforms.includes(prop) || shortTransforms.get(prop) ? tweenTypes.TRANSFORM : (
              // CSS variables
              stringStartsWith(prop, "--") ? tweenTypes.CSS_VAR : (
                // All other CSS properties
                prop in /** @type {DOMTarget} */
                target.style ? tweenTypes.CSS : (
                  // Handle other DOM Attributes
                  prop in target ? tweenTypes.OBJECT : tweenTypes.ATTRIBUTE
                )
              )
            )
          )
        );
      }, "getTweenType");
      getCSSValue = /* @__PURE__ */ __name((target, propName, animationInlineStyles) => {
        const inlineStyles = target.style[propName];
        if (inlineStyles && animationInlineStyles) {
          animationInlineStyles[propName] = inlineStyles;
        }
        const value = inlineStyles || getComputedStyle(target[proxyTargetSymbol] || target).getPropertyValue(propName);
        return value === "auto" ? "0" : value;
      }, "getCSSValue");
      getOriginalAnimatableValue = /* @__PURE__ */ __name((target, propName, tweenType, animationInlineStyles) => {
        const type = !isUnd(tweenType) ? tweenType : getTweenType(target, propName);
        return type === tweenTypes.OBJECT ? target[propName] || 0 : type === tweenTypes.ATTRIBUTE ? (
          /** @type {DOMTarget} */
          target.getAttribute(propName)
        ) : type === tweenTypes.TRANSFORM ? parseInlineTransforms(
          /** @type {DOMTarget} */
          target,
          propName,
          animationInlineStyles
        ) : type === tweenTypes.CSS_VAR ? getCSSValue(
          /** @type {DOMTarget} */
          target,
          propName,
          animationInlineStyles
        ).trimStart() : getCSSValue(
          /** @type {DOMTarget} */
          target,
          propName,
          animationInlineStyles
        );
      }, "getOriginalAnimatableValue");
      getRelativeValue = /* @__PURE__ */ __name((x4, y3, operator) => {
        return operator === "-" ? x4 - y3 : operator === "+" ? x4 + y3 : x4 * y3;
      }, "getRelativeValue");
      createDecomposedValueTargetObject = /* @__PURE__ */ __name(() => {
        return {
          /** @type {valueTypes} */
          t: valueTypes.NUMBER,
          n: 0,
          u: null,
          o: null,
          d: null,
          s: null
        };
      }, "createDecomposedValueTargetObject");
      decomposeRawValue = /* @__PURE__ */ __name((rawValue, targetObject) => {
        targetObject.t = valueTypes.NUMBER;
        targetObject.n = 0;
        targetObject.u = null;
        targetObject.o = null;
        targetObject.d = null;
        targetObject.s = null;
        if (!rawValue) return targetObject;
        const num = +rawValue;
        if (!isNaN(num)) {
          targetObject.n = num;
          return targetObject;
        } else {
          let str = (
            /** @type {String} */
            rawValue
          );
          if (str[1] === "=") {
            targetObject.o = str[0];
            str = str.slice(2);
          }
          const unitMatch = str.includes(" ") ? false : unitsExecRgx.exec(str);
          if (unitMatch) {
            targetObject.t = valueTypes.UNIT;
            targetObject.n = +unitMatch[1];
            targetObject.u = unitMatch[2];
            return targetObject;
          } else if (targetObject.o) {
            targetObject.n = +str;
            return targetObject;
          } else if (isCol(str)) {
            targetObject.t = valueTypes.COLOR;
            targetObject.d = convertColorStringValuesToRgbaArray(str);
            return targetObject;
          } else {
            const matchedNumbers = str.match(digitWithExponentRgx);
            targetObject.t = valueTypes.COMPLEX;
            targetObject.d = matchedNumbers ? matchedNumbers.map(Number) : [];
            targetObject.s = str.split(digitWithExponentRgx) || [];
            return targetObject;
          }
        }
      }, "decomposeRawValue");
      decomposeTweenValue = /* @__PURE__ */ __name((tween, targetObject) => {
        targetObject.t = tween._valueType;
        targetObject.n = tween._toNumber;
        targetObject.u = tween._unit;
        targetObject.o = null;
        targetObject.d = cloneArray(tween._toNumbers);
        targetObject.s = cloneArray(tween._strings);
        return targetObject;
      }, "decomposeTweenValue");
      decomposedOriginalValue = createDecomposedValueTargetObject();
      lookups = {
        /** @type {TweenReplaceLookups} */
        _rep: /* @__PURE__ */ new WeakMap(),
        /** @type {TweenAdditiveLookups} */
        _add: /* @__PURE__ */ new Map()
      };
      getTweenSiblings = /* @__PURE__ */ __name((target, property, lookup = "_rep") => {
        const lookupMap = lookups[lookup];
        let targetLookup = lookupMap.get(target);
        if (!targetLookup) {
          targetLookup = {};
          lookupMap.set(target, targetLookup);
        }
        return targetLookup[property] ? targetLookup[property] : targetLookup[property] = {
          _head: null,
          _tail: null
        };
      }, "getTweenSiblings");
      addTweenSortMethod = /* @__PURE__ */ __name((p3, c3) => {
        return p3._isOverridden || p3._absoluteStartTime > c3._absoluteStartTime;
      }, "addTweenSortMethod");
      overrideTween = /* @__PURE__ */ __name((tween) => {
        tween._isOverlapped = 1;
        tween._isOverridden = 1;
        tween._changeDuration = minValue;
        tween._currentTime = minValue;
      }, "overrideTween");
      composeTween = /* @__PURE__ */ __name((tween, siblings) => {
        const tweenCompositionType = tween._composition;
        if (tweenCompositionType === compositionTypes.replace) {
          const tweenAbsStartTime = tween._absoluteStartTime;
          addChild(siblings, tween, addTweenSortMethod, "_prevRep", "_nextRep");
          const prevSibling = tween._prevRep;
          if (prevSibling) {
            const prevParent = prevSibling.parent;
            const prevAbsEndTime = prevSibling._absoluteStartTime + prevSibling._changeDuration;
            if (
              // Check if the previous tween is from a different animation
              tween.parent.id !== prevParent.id && // Check if the animation has loops
              prevParent.iterationCount > 1 && // Check if _absoluteChangeEndTime of last loop overlaps the current tween
              prevAbsEndTime + (prevParent.duration - prevParent.iterationDuration) > tweenAbsStartTime
            ) {
              overrideTween(prevSibling);
              let prevPrevSibling = prevSibling._prevRep;
              while (prevPrevSibling && prevPrevSibling.parent.id === prevParent.id) {
                overrideTween(prevPrevSibling);
                prevPrevSibling = prevPrevSibling._prevRep;
              }
            }
            const absoluteUpdateStartTime = tweenAbsStartTime - tween._delay;
            if (prevAbsEndTime > absoluteUpdateStartTime) {
              const prevChangeStartTime = prevSibling._startTime;
              const prevTLOffset = prevAbsEndTime - (prevChangeStartTime + prevSibling._updateDuration);
              prevSibling._changeDuration = absoluteUpdateStartTime - prevTLOffset - prevChangeStartTime;
              prevSibling._currentTime = prevSibling._changeDuration;
              prevSibling._isOverlapped = 1;
              if (prevSibling._changeDuration < minValue) {
                overrideTween(prevSibling);
              }
            }
            let pausePrevParentAnimation = true;
            forEachChildren(prevParent, (t4) => {
              if (!t4._isOverlapped) pausePrevParentAnimation = false;
            });
            if (pausePrevParentAnimation) {
              const prevParentTL = prevParent.parent;
              if (prevParentTL) {
                let pausePrevParentTL = true;
                forEachChildren(prevParentTL, (a3) => {
                  if (a3 !== prevParent) {
                    forEachChildren(a3, (t4) => {
                      if (!t4._isOverlapped) pausePrevParentTL = false;
                    });
                  }
                });
                if (pausePrevParentTL) {
                  prevParentTL.cancel();
                }
              } else {
                prevParent.cancel();
              }
            }
          }
        } else if (tweenCompositionType === compositionTypes.blend) {
          const additiveTweenSiblings = getTweenSiblings(tween.target, tween.property, "_add");
          const additiveAnimation = addAdditiveAnimation(lookups._add);
          let lookupTween = additiveTweenSiblings._head;
          if (!lookupTween) {
            lookupTween = { ...tween };
            lookupTween._composition = compositionTypes.replace;
            lookupTween._updateDuration = minValue;
            lookupTween._startTime = 0;
            lookupTween._numbers = cloneArray(tween._fromNumbers);
            lookupTween._number = 0;
            lookupTween._next = null;
            lookupTween._prev = null;
            addChild(additiveTweenSiblings, lookupTween);
            addChild(additiveAnimation, lookupTween);
          }
          const toNumber = tween._toNumber;
          tween._fromNumber = lookupTween._fromNumber - toNumber;
          tween._toNumber = 0;
          tween._numbers = cloneArray(tween._fromNumbers);
          tween._number = 0;
          lookupTween._fromNumber = toNumber;
          if (tween._toNumbers) {
            const toNumbers = cloneArray(tween._toNumbers);
            if (toNumbers) {
              toNumbers.forEach((value, i3) => {
                tween._fromNumbers[i3] = lookupTween._fromNumbers[i3] - value;
                tween._toNumbers[i3] = 0;
              });
            }
            lookupTween._fromNumbers = toNumbers;
          }
          addChild(additiveTweenSiblings, tween, null, "_prevAdd", "_nextAdd");
        }
        return tween;
      }, "composeTween");
      removeTweenSliblings = /* @__PURE__ */ __name((tween) => {
        const tweenComposition = tween._composition;
        if (tweenComposition !== compositionTypes.none) {
          const tweenTarget = tween.target;
          const tweenProperty = tween.property;
          const replaceTweensLookup = lookups._rep;
          const replaceTargetProps = replaceTweensLookup.get(tweenTarget);
          const tweenReplaceSiblings = replaceTargetProps[tweenProperty];
          removeChild(tweenReplaceSiblings, tween, "_prevRep", "_nextRep");
          if (tweenComposition === compositionTypes.blend) {
            const addTweensLookup = lookups._add;
            const addTargetProps = addTweensLookup.get(tweenTarget);
            if (!addTargetProps) return;
            const additiveTweenSiblings = addTargetProps[tweenProperty];
            const additiveAnimation = additive.animation;
            removeChild(additiveTweenSiblings, tween, "_prevAdd", "_nextAdd");
            const lookupTween = additiveTweenSiblings._head;
            if (lookupTween && lookupTween === additiveTweenSiblings._tail) {
              removeChild(additiveTweenSiblings, lookupTween, "_prevAdd", "_nextAdd");
              removeChild(additiveAnimation, lookupTween);
              let shouldClean = true;
              for (let prop in addTargetProps) {
                if (addTargetProps[prop]._head) {
                  shouldClean = false;
                  break;
                }
              }
              if (shouldClean) {
                addTweensLookup.delete(tweenTarget);
              }
            }
          }
        }
        return tween;
      }, "removeTweenSliblings");
      resetTimerProperties = /* @__PURE__ */ __name((timer) => {
        timer.paused = true;
        timer.began = false;
        timer.completed = false;
        return timer;
      }, "resetTimerProperties");
      reviveTimer = /* @__PURE__ */ __name((timer) => {
        if (!timer._cancelled) return timer;
        if (timer._hasChildren) {
          forEachChildren(timer, reviveTimer);
        } else {
          forEachChildren(timer, (tween) => {
            if (tween._composition !== compositionTypes.none) {
              composeTween(tween, getTweenSiblings(tween.target, tween.property));
            }
          });
        }
        timer._cancelled = 0;
        return timer;
      }, "reviveTimer");
      timerId = 0;
      Timer = class extends Clock {
        static {
          __name(this, "Timer");
        }
        /**
         * @param {TimerParams} [parameters]
         * @param {Timeline} [parent]
         * @param {Number} [parentPosition]
         */
        constructor(parameters = {}, parent = null, parentPosition = 0) {
          super(0);
          const {
            id,
            delay,
            duration,
            reversed,
            alternate,
            loop,
            loopDelay,
            autoplay,
            frameRate,
            playbackRate,
            onComplete,
            onLoop,
            onPause,
            onBegin,
            onBeforeUpdate,
            onUpdate
          } = parameters;
          if (scope2.current) scope2.current.register(this);
          const timerInitTime = parent ? 0 : engine._elapsedTime;
          const timerDefaults = parent ? parent.defaults : globals.defaults;
          const timerDelay = (
            /** @type {Number} */
            isFnc(delay) || isUnd(delay) ? timerDefaults.delay : +delay
          );
          const timerDuration = isFnc(duration) || isUnd(duration) ? Infinity : +duration;
          const timerLoop = setValue(loop, timerDefaults.loop);
          const timerLoopDelay = setValue(loopDelay, timerDefaults.loopDelay);
          const timerIterationCount = timerLoop === true || timerLoop === Infinity || /** @type {Number} */
          timerLoop < 0 ? Infinity : (
            /** @type {Number} */
            timerLoop + 1
          );
          let offsetPosition = 0;
          if (parent) {
            offsetPosition = parentPosition;
          } else {
            let startTime = now();
            if (engine.paused) {
              engine.requestTick(startTime);
              startTime = engine._elapsedTime;
            }
            offsetPosition = startTime - engine._startTime;
          }
          this.id = !isUnd(id) ? id : ++timerId;
          this.parent = parent;
          this.duration = clampInfinity((timerDuration + timerLoopDelay) * timerIterationCount - timerLoopDelay) || minValue;
          this.backwards = false;
          this.paused = true;
          this.began = false;
          this.completed = false;
          this.onBegin = onBegin || timerDefaults.onBegin;
          this.onBeforeUpdate = onBeforeUpdate || timerDefaults.onBeforeUpdate;
          this.onUpdate = onUpdate || timerDefaults.onUpdate;
          this.onLoop = onLoop || timerDefaults.onLoop;
          this.onPause = onPause || timerDefaults.onPause;
          this.onComplete = onComplete || timerDefaults.onComplete;
          this.iterationDuration = timerDuration;
          this.iterationCount = timerIterationCount;
          this._autoplay = parent ? false : setValue(autoplay, timerDefaults.autoplay);
          this._offset = offsetPosition;
          this._delay = timerDelay;
          this._loopDelay = timerLoopDelay;
          this._iterationTime = 0;
          this._currentIteration = 0;
          this._resolve = noop;
          this._running = false;
          this._reversed = +setValue(reversed, timerDefaults.reversed);
          this._reverse = this._reversed;
          this._cancelled = 0;
          this._alternate = setValue(alternate, timerDefaults.alternate);
          this._prev = null;
          this._next = null;
          this._elapsedTime = timerInitTime;
          this._startTime = timerInitTime;
          this._lastTime = timerInitTime;
          this._fps = setValue(frameRate, timerDefaults.frameRate);
          this._speed = setValue(playbackRate, timerDefaults.playbackRate);
        }
        get cancelled() {
          return !!this._cancelled;
        }
        /** @param {Boolean} cancelled  */
        set cancelled(cancelled) {
          cancelled ? this.cancel() : this.reset(1).play();
        }
        get currentTime() {
          return clamp(round(this._currentTime, globals.precision), -this._delay, this.duration);
        }
        /** @param {Number} time  */
        set currentTime(time) {
          const paused = this.paused;
          this.pause().seek(+time);
          if (!paused) this.resume();
        }
        get iterationCurrentTime() {
          return round(this._iterationTime, globals.precision);
        }
        /** @param {Number} time  */
        set iterationCurrentTime(time) {
          this.currentTime = this.iterationDuration * this._currentIteration + time;
        }
        get progress() {
          return clamp(round(this._currentTime / this.duration, 10), 0, 1);
        }
        /** @param {Number} progress  */
        set progress(progress) {
          this.currentTime = this.duration * progress;
        }
        get iterationProgress() {
          return clamp(round(this._iterationTime / this.iterationDuration, 10), 0, 1);
        }
        /** @param {Number} progress  */
        set iterationProgress(progress) {
          const iterationDuration = this.iterationDuration;
          this.currentTime = iterationDuration * this._currentIteration + iterationDuration * progress;
        }
        get currentIteration() {
          return this._currentIteration;
        }
        /** @param {Number} iterationCount  */
        set currentIteration(iterationCount) {
          this.currentTime = this.iterationDuration * clamp(+iterationCount, 0, this.iterationCount - 1);
        }
        get reversed() {
          return !!this._reversed;
        }
        /** @param {Boolean} reverse  */
        set reversed(reverse) {
          reverse ? this.reverse() : this.play();
        }
        get speed() {
          return super.speed;
        }
        /** @param {Number} playbackRate  */
        set speed(playbackRate) {
          super.speed = playbackRate;
          this.resetTime();
        }
        /**
         * @param  {Number} internalRender
         * @return {this}
         */
        reset(internalRender = 0) {
          reviveTimer(this);
          if (this._reversed && !this._reverse) this.reversed = false;
          this._iterationTime = this.iterationDuration;
          tick(this, 0, 1, internalRender, tickModes.FORCE);
          resetTimerProperties(this);
          if (this._hasChildren) {
            forEachChildren(this, resetTimerProperties);
          }
          return this;
        }
        /**
         * @param  {Number} internalRender
         * @return {this}
         */
        init(internalRender = 0) {
          this.fps = this._fps;
          this.speed = this._speed;
          if (!internalRender && this._hasChildren) {
            tick(this, this.duration, 1, internalRender, tickModes.FORCE);
          }
          this.reset(internalRender);
          const autoplay = this._autoplay;
          if (autoplay === true) {
            this.resume();
          } else if (autoplay && !isUnd(
            /** @type {ScrollObserver} */
            autoplay.linked
          )) {
            autoplay.link(this);
          }
          return this;
        }
        /** @return {this} */
        resetTime() {
          const timeScale = 1 / (this._speed * engine._speed);
          this._startTime = now() - (this._currentTime + this._delay) * timeScale;
          return this;
        }
        /** @return {this} */
        pause() {
          if (this.paused) return this;
          this.paused = true;
          this.onPause(this);
          return this;
        }
        /** @return {this} */
        resume() {
          if (!this.paused) return this;
          this.paused = false;
          if (this.duration <= minValue && !this._hasChildren) {
            tick(this, minValue, 0, 0, tickModes.FORCE);
          } else {
            if (!this._running) {
              addChild(engine, this);
              engine._hasChildren = true;
              this._running = true;
            }
            this.resetTime();
            this._startTime -= 12;
            engine.wake();
          }
          return this;
        }
        /** @return {this} */
        restart() {
          return this.reset(0).resume();
        }
        /**
         * @param  {Number} time
         * @param  {Boolean|Number} [muteCallbacks]
         * @param  {Boolean|Number} [internalRender]
         * @return {this}
         */
        seek(time, muteCallbacks = 0, internalRender = 0) {
          reviveTimer(this);
          this.completed = false;
          const isPaused = this.paused;
          this.paused = true;
          tick(this, time + this._delay, ~~muteCallbacks, ~~internalRender, tickModes.AUTO);
          return isPaused ? this : this.resume();
        }
        /** @return {this} */
        alternate() {
          const reversed = this._reversed;
          const count = this.iterationCount;
          const duration = this.iterationDuration;
          const iterations = count === Infinity ? floor(maxValue / duration) : count;
          this._reversed = +(this._alternate && !(iterations % 2) ? reversed : !reversed);
          if (count === Infinity) {
            this.iterationProgress = this._reversed ? 1 - this.iterationProgress : this.iterationProgress;
          } else {
            this.seek(duration * iterations - this._currentTime);
          }
          this.resetTime();
          return this;
        }
        /** @return {this} */
        play() {
          if (this._reversed) this.alternate();
          return this.resume();
        }
        /** @return {this} */
        reverse() {
          if (!this._reversed) this.alternate();
          return this.resume();
        }
        // TODO: Move all the animation / tweens / children related code to Animation / Timeline
        /** @return {this} */
        cancel() {
          if (this._hasChildren) {
            forEachChildren(this, (child) => child.cancel(), true);
          } else {
            forEachChildren(this, removeTweenSliblings);
          }
          this._cancelled = 1;
          return this.pause();
        }
        /**
         * @param  {Number} newDuration
         * @return {this}
         */
        stretch(newDuration) {
          const currentDuration = this.duration;
          const normlizedDuration = normalizeTime(newDuration);
          if (currentDuration === normlizedDuration) return this;
          const timeScale = newDuration / currentDuration;
          const isSetter = newDuration <= minValue;
          this.duration = isSetter ? minValue : normlizedDuration;
          this.iterationDuration = isSetter ? minValue : normalizeTime(this.iterationDuration * timeScale);
          this._offset *= timeScale;
          this._delay *= timeScale;
          this._loopDelay *= timeScale;
          return this;
        }
        /**
          * Cancels the timer by seeking it back to 0 and reverting the attached scroller if necessary
          * @return {this}
          */
        revert() {
          tick(this, 0, 1, 0, tickModes.AUTO);
          const ap = (
            /** @type {ScrollObserver} */
            this._autoplay
          );
          if (ap && ap.linked && ap.linked === this) ap.revert();
          return this.cancel();
        }
        /**
          * Imediatly completes the timer, cancels it and triggers the onComplete callback
          * @return {this}
          */
        complete() {
          return this.seek(this.duration).cancel();
        }
        /**
         * @param  {Callback<this>} [callback]
         * @return {Promise}
         */
        then(callback = noop) {
          const then = this.then;
          const onResolve = /* @__PURE__ */ __name(() => {
            this.then = null;
            callback(this);
            this.then = then;
            this._resolve = noop;
          }, "onResolve");
          return new Promise((r3) => {
            this._resolve = () => r3(onResolve());
            if (this.completed) this._resolve();
            return this;
          });
        }
      };
      none = /* @__PURE__ */ __name((t4) => t4, "none");
      calcBezier = /* @__PURE__ */ __name((aT, aA1, aA2) => (((1 - 3 * aA2 + 3 * aA1) * aT + (3 * aA2 - 6 * aA1)) * aT + 3 * aA1) * aT, "calcBezier");
      binarySubdivide = /* @__PURE__ */ __name((aX, mX1, mX2) => {
        let aA = 0, aB = 1, currentX, currentT, i3 = 0;
        do {
          currentT = aA + (aB - aA) / 2;
          currentX = calcBezier(currentT, mX1, mX2) - aX;
          if (currentX > 0) {
            aB = currentT;
          } else {
            aA = currentT;
          }
        } while (abs(currentX) > 1e-7 && ++i3 < 100);
        return currentT;
      }, "binarySubdivide");
      cubicBezier = /* @__PURE__ */ __name((mX1 = 0.5, mY1 = 0, mX2 = 0.5, mY2 = 1) => mX1 === mY1 && mX2 === mY2 ? none : (t4) => t4 === 0 || t4 === 1 ? t4 : calcBezier(binarySubdivide(t4, mX1, mX2), mY1, mY2), "cubicBezier");
      steps = /* @__PURE__ */ __name((steps2 = 10, fromStart) => {
        const roundMethod = fromStart ? ceil : floor;
        return (t4) => roundMethod(clamp(t4, 0, 1) * steps2) * (1 / steps2);
      }, "steps");
      linear = /* @__PURE__ */ __name((...args) => {
        const argsLength = args.length;
        if (!argsLength) return none;
        const totalPoints = argsLength - 1;
        const firstArg = args[0];
        const lastArg = args[totalPoints];
        const xPoints = [0];
        const yPoints = [parseNumber(firstArg)];
        for (let i3 = 1; i3 < totalPoints; i3++) {
          const arg = args[i3];
          const splitValue = isStr(arg) ? (
            /** @type {String} */
            arg.trim().split(" ")
          ) : [arg];
          const value = splitValue[0];
          const percent = splitValue[1];
          xPoints.push(!isUnd(percent) ? parseNumber(percent) / 100 : i3 / totalPoints);
          yPoints.push(parseNumber(value));
        }
        yPoints.push(parseNumber(lastArg));
        xPoints.push(1);
        return /* @__PURE__ */ __name(function easeLinear(t4) {
          for (let i3 = 1, l3 = xPoints.length; i3 < l3; i3++) {
            const currentX = xPoints[i3];
            if (t4 <= currentX) {
              const prevX = xPoints[i3 - 1];
              const prevY = yPoints[i3 - 1];
              return prevY + (yPoints[i3] - prevY) * (t4 - prevX) / (currentX - prevX);
            }
          }
          return yPoints[yPoints.length - 1];
        }, "easeLinear");
      }, "linear");
      irregular = /* @__PURE__ */ __name((length = 10, randomness = 1) => {
        const values = [0];
        const total = length - 1;
        for (let i3 = 1; i3 < total; i3++) {
          const previousValue = values[i3 - 1];
          const spacing = i3 / total;
          const segmentEnd = (i3 + 1) / total;
          const randomVariation = spacing + (segmentEnd - spacing) * Math.random();
          const randomValue = spacing * (1 - randomness) + randomVariation * randomness;
          values.push(clamp(randomValue, previousValue, 1));
        }
        values.push(1);
        return linear(...values);
      }, "irregular");
      halfPI = PI / 2;
      doublePI = PI * 2;
      easeInPower = /* @__PURE__ */ __name((p3 = 1.68) => (t4) => pow(t4, +p3), "easeInPower");
      easeInFunctions = {
        [emptyString]: easeInPower,
        Quad: easeInPower(2),
        Cubic: easeInPower(3),
        Quart: easeInPower(4),
        Quint: easeInPower(5),
        /** @type {EasingFunction} */
        Sine: /* @__PURE__ */ __name((t4) => 1 - cos(t4 * halfPI), "Sine"),
        /** @type {EasingFunction} */
        Circ: /* @__PURE__ */ __name((t4) => 1 - sqrt(1 - t4 * t4), "Circ"),
        /** @type {EasingFunction} */
        Expo: /* @__PURE__ */ __name((t4) => t4 ? pow(2, 10 * t4 - 10) : 0, "Expo"),
        /** @type {EasingFunction} */
        Bounce: /* @__PURE__ */ __name((t4) => {
          let pow2, b2 = 4;
          while (t4 < ((pow2 = pow(2, --b2)) - 1) / 11) ;
          return 1 / pow(4, 3 - b2) - 7.5625 * pow((pow2 * 3 - 2) / 22 - t4, 2);
        }, "Bounce"),
        /** @type {BackEasing} */
        Back: /* @__PURE__ */ __name((overshoot = 1.70158) => (t4) => (+overshoot + 1) * t4 * t4 * t4 - +overshoot * t4 * t4, "Back"),
        /** @type {ElasticEasing} */
        Elastic: /* @__PURE__ */ __name((amplitude = 1, period = 0.3) => {
          const a3 = clamp(+amplitude, 1, 10);
          const p3 = clamp(+period, minValue, 2);
          const s3 = p3 / doublePI * asin(1 / a3);
          const e3 = doublePI / p3;
          return (t4) => t4 === 0 || t4 === 1 ? t4 : -a3 * pow(2, -10 * (1 - t4)) * sin((1 - t4 - s3) * e3);
        }, "Elastic")
      };
      easeTypes = {
        in: /* @__PURE__ */ __name((easeIn) => (t4) => easeIn(t4), "in"),
        out: /* @__PURE__ */ __name((easeIn) => (t4) => 1 - easeIn(1 - t4), "out"),
        inOut: /* @__PURE__ */ __name((easeIn) => (t4) => t4 < 0.5 ? easeIn(t4 * 2) / 2 : 1 - easeIn(t4 * -2 + 2) / 2, "inOut"),
        outIn: /* @__PURE__ */ __name((easeIn) => (t4) => t4 < 0.5 ? (1 - easeIn(1 - t4 * 2)) / 2 : (easeIn(t4 * 2 - 1) + 1) / 2, "outIn")
      };
      parseEaseString = /* @__PURE__ */ __name((string, easesFunctions, easesLookups) => {
        if (easesLookups[string]) return easesLookups[string];
        if (string.indexOf("(") <= -1) {
          const hasParams = easeTypes[string] || string.includes("Back") || string.includes("Elastic");
          const parsedFn = (
            /** @type {EasingFunction} */
            hasParams ? (
              /** @type {EasesFactory} */
              easesFunctions[string]()
            ) : easesFunctions[string]
          );
          return parsedFn ? easesLookups[string] = parsedFn : none;
        } else {
          const split = string.slice(0, -1).split("(");
          const parsedFn = (
            /** @type {EasesFactory} */
            easesFunctions[split[0]]
          );
          return parsedFn ? easesLookups[string] = parsedFn(...split[1].split(",")) : none;
        }
      }, "parseEaseString");
      eases = /* @__PURE__ */ (() => {
        const list2 = { linear, irregular, steps, cubicBezier };
        for (let type in easeTypes) {
          for (let name in easeInFunctions) {
            const easeIn = easeInFunctions[name];
            const easeType = easeTypes[type];
            list2[type + name] = /** @type {EasesFactory|EasingFunction} */
            name === emptyString || name === "Back" || name === "Elastic" ? (a3, b2) => easeType(
              /** @type {EasesFactory} */
              easeIn(a3, b2)
            ) : easeType(
              /** @type {EasingFunction} */
              easeIn
            );
          }
        }
        return (
          /** @type {EasesFunctions} */
          list2
        );
      })();
      JSEasesLookups = { linear: none };
      parseEasings = /* @__PURE__ */ __name((ease) => isFnc(ease) ? ease : isStr(ease) ? parseEaseString(
        /** @type {String} */
        ease,
        eases,
        JSEasesLookups
      ) : none, "parseEasings");
      propertyNamesCache = {};
      sanitizePropertyName = /* @__PURE__ */ __name((propertyName, target, tweenType) => {
        if (tweenType === tweenTypes.TRANSFORM) {
          const t4 = shortTransforms.get(propertyName);
          return t4 ? t4 : propertyName;
        } else if (tweenType === tweenTypes.CSS || // Handle special cases where properties like "strokeDashoffset" needs to be set as "stroke-dashoffset"
        // but properties like "baseFrequency" should stay in lowerCamelCase
        tweenType === tweenTypes.ATTRIBUTE && (isSvg(target) && propertyName in /** @type {DOMTarget} */
        target.style)) {
          const cachedPropertyName = propertyNamesCache[propertyName];
          if (cachedPropertyName) {
            return cachedPropertyName;
          } else {
            const lowerCaseName = propertyName ? toLowerCase(propertyName) : propertyName;
            propertyNamesCache[propertyName] = lowerCaseName;
            return lowerCaseName;
          }
        } else {
          return propertyName;
        }
      }, "sanitizePropertyName");
      angleUnitsMap = { "deg": 1, "rad": 180 / PI, "turn": 360 };
      convertedValuesCache = {};
      convertValueUnit = /* @__PURE__ */ __name((el, decomposedValue, unit, force = false) => {
        const currentUnit = decomposedValue.u;
        const currentNumber = decomposedValue.n;
        if (decomposedValue.t === valueTypes.UNIT && currentUnit === unit) {
          return decomposedValue;
        }
        const cachedKey = currentNumber + currentUnit + unit;
        const cached = convertedValuesCache[cachedKey];
        if (!isUnd(cached) && !force) {
          decomposedValue.n = cached;
        } else {
          let convertedValue;
          if (currentUnit in angleUnitsMap) {
            convertedValue = currentNumber * angleUnitsMap[currentUnit] / angleUnitsMap[unit];
          } else {
            const baseline = 100;
            const tempEl = (
              /** @type {DOMTarget} */
              el.cloneNode()
            );
            const parentNode = el.parentNode;
            const parentEl = parentNode && parentNode !== doc ? parentNode : doc.body;
            parentEl.appendChild(tempEl);
            const elStyle = tempEl.style;
            elStyle.width = baseline + currentUnit;
            const currentUnitWidth = (
              /** @type {HTMLElement} */
              tempEl.offsetWidth || baseline
            );
            elStyle.width = baseline + unit;
            const newUnitWidth = (
              /** @type {HTMLElement} */
              tempEl.offsetWidth || baseline
            );
            const factor = currentUnitWidth / newUnitWidth;
            parentEl.removeChild(tempEl);
            convertedValue = factor * currentNumber;
          }
          decomposedValue.n = convertedValue;
          convertedValuesCache[cachedKey] = convertedValue;
        }
        decomposedValue.t === valueTypes.UNIT;
        decomposedValue.u = unit;
        return decomposedValue;
      }, "convertValueUnit");
      cleanInlineStyles = /* @__PURE__ */ __name((renderable) => {
        if (renderable._hasChildren) {
          forEachChildren(renderable, cleanInlineStyles, true);
        } else {
          const animation = (
            /** @type {JSAnimation} */
            renderable
          );
          animation.pause();
          forEachChildren(animation, (tween) => {
            const tweenProperty = tween.property;
            const tweenTarget = tween.target;
            if (tweenTarget[isDomSymbol]) {
              const targetStyle = (
                /** @type {DOMTarget} */
                tweenTarget.style
              );
              const originalInlinedValue = animation._inlineStyles[tweenProperty];
              if (tween._tweenType === tweenTypes.TRANSFORM) {
                const cachedTransforms = tweenTarget[transformsSymbol];
                if (isUnd(originalInlinedValue) || originalInlinedValue === emptyString) {
                  delete cachedTransforms[tweenProperty];
                } else {
                  cachedTransforms[tweenProperty] = originalInlinedValue;
                }
                if (tween._renderTransforms) {
                  if (!Object.keys(cachedTransforms).length) {
                    targetStyle.removeProperty("transform");
                  } else {
                    let str = emptyString;
                    for (let key2 in cachedTransforms) {
                      str += transformsFragmentStrings[key2] + cachedTransforms[key2] + ") ";
                    }
                    targetStyle.transform = str;
                  }
                }
              } else {
                if (isUnd(originalInlinedValue) || originalInlinedValue === emptyString) {
                  targetStyle.removeProperty(tweenProperty);
                } else {
                  targetStyle[tweenProperty] = originalInlinedValue;
                }
              }
              if (animation._tail === tween) {
                animation.targets.forEach((t4) => {
                  if (t4.getAttribute && t4.getAttribute("style") === emptyString) {
                    t4.removeAttribute("style");
                  }
                });
              }
            }
          });
        }
        return renderable;
      }, "cleanInlineStyles");
      fromTargetObject = createDecomposedValueTargetObject();
      toTargetObject = createDecomposedValueTargetObject();
      toFunctionStore = { func: null };
      keyframesTargetArray = [null];
      fastSetValuesArray = [null, null];
      keyObjectTarget = { to: null };
      tweenId = 0;
      generateKeyframes = /* @__PURE__ */ __name((keyframes2, parameters) => {
        const properties = {};
        if (isArr(keyframes2)) {
          const propertyNames = [].concat(.../** @type {DurationKeyframes} */
          keyframes2.map((key2) => Object.keys(key2))).filter(isKey);
          for (let i3 = 0, l3 = propertyNames.length; i3 < l3; i3++) {
            const propName = propertyNames[i3];
            const propArray = (
              /** @type {DurationKeyframes} */
              keyframes2.map((key2) => {
                const newKey = {};
                for (let p3 in key2) {
                  const keyValue = (
                    /** @type {TweenPropValue} */
                    key2[p3]
                  );
                  if (isKey(p3)) {
                    if (p3 === propName) {
                      newKey.to = keyValue;
                    }
                  } else {
                    newKey[p3] = keyValue;
                  }
                }
                return newKey;
              })
            );
            properties[propName] = /** @type {ArraySyntaxValue} */
            propArray;
          }
        } else {
          const totalDuration = (
            /** @type {Number} */
            setValue(parameters.duration, globals.defaults.duration)
          );
          const keys = Object.keys(keyframes2).map((key2) => {
            return { o: parseFloat(key2) / 100, p: keyframes2[key2] };
          }).sort((a3, b2) => a3.o - b2.o);
          keys.forEach((key2) => {
            const offset = key2.o;
            const prop = key2.p;
            for (let name in prop) {
              if (isKey(name)) {
                let propArray = (
                  /** @type {Array} */
                  properties[name]
                );
                if (!propArray) propArray = properties[name] = [];
                const duration = offset * totalDuration;
                let length = propArray.length;
                let prevKey = propArray[length - 1];
                const keyObj = { to: prop[name] };
                let durProgress = 0;
                for (let i3 = 0; i3 < length; i3++) {
                  durProgress += propArray[i3].duration;
                }
                if (length === 1) {
                  keyObj.from = prevKey.to;
                }
                if (prop.ease) {
                  keyObj.ease = prop.ease;
                }
                keyObj.duration = duration - (length ? durProgress : 0);
                propArray.push(keyObj);
              }
            }
            return key2;
          });
          for (let name in properties) {
            const propArray = (
              /** @type {Array} */
              properties[name]
            );
            let prevEase;
            for (let i3 = 0, l3 = propArray.length; i3 < l3; i3++) {
              const prop = propArray[i3];
              const currentEase = prop.ease;
              prop.ease = prevEase ? prevEase : void 0;
              prevEase = currentEase;
            }
            if (!propArray[0].duration) {
              propArray.shift();
            }
          }
        }
        return properties;
      }, "generateKeyframes");
      JSAnimation = class extends Timer {
        static {
          __name(this, "JSAnimation");
        }
        /**
         * @param {TargetsParam} targets
         * @param {AnimationParams} parameters
         * @param {Timeline} [parent]
         * @param {Number} [parentPosition]
         * @param {Boolean} [fastSet=false]
         * @param {Number} [index=0]
         * @param {Number} [length=0]
         */
        constructor(targets, parameters, parent, parentPosition, fastSet = false, index = 0, length = 0) {
          super(
            /** @type {TimerParams&AnimationParams} */
            parameters,
            parent,
            parentPosition
          );
          const parsedTargets = registerTargets(targets);
          const targetsLength = parsedTargets.length;
          const kfParams = (
            /** @type {AnimationParams} */
            parameters.keyframes
          );
          const params = (
            /** @type {AnimationParams} */
            kfParams ? mergeObjects(generateKeyframes(
              /** @type {DurationKeyframes} */
              kfParams,
              parameters
            ), parameters) : parameters
          );
          const {
            delay,
            duration,
            ease,
            playbackEase,
            modifier,
            composition,
            onRender
          } = params;
          const animDefaults = parent ? parent.defaults : globals.defaults;
          const animaPlaybackEase = setValue(playbackEase, animDefaults.playbackEase);
          const animEase = animaPlaybackEase ? parseEasings(animaPlaybackEase) : null;
          const hasSpring = !isUnd(ease) && !isUnd(
            /** @type {Spring} */
            ease.ease
          );
          const tEasing = hasSpring ? (
            /** @type {Spring} */
            ease.ease
          ) : setValue(ease, animEase ? "linear" : animDefaults.ease);
          const tDuration = hasSpring ? (
            /** @type {Spring} */
            ease.duration
          ) : setValue(duration, animDefaults.duration);
          const tDelay = setValue(delay, animDefaults.delay);
          const tModifier = modifier || animDefaults.modifier;
          const tComposition = isUnd(composition) && targetsLength >= K2 ? compositionTypes.none : !isUnd(composition) ? composition : animDefaults.composition;
          const animInlineStyles = {};
          const absoluteOffsetTime = this._offset + (parent ? parent._offset : 0);
          let iterationDuration = NaN;
          let iterationDelay = NaN;
          let animationAnimationLength = 0;
          let shouldTriggerRender = 0;
          for (let targetIndex = 0; targetIndex < targetsLength; targetIndex++) {
            const target = parsedTargets[targetIndex];
            const ti = index || targetIndex;
            const tl = length || targetsLength;
            let lastTransformGroupIndex = NaN;
            let lastTransformGroupLength = NaN;
            for (let p3 in params) {
              if (isKey(p3)) {
                const tweenType = getTweenType(target, p3);
                const propName = sanitizePropertyName(p3, target, tweenType);
                let propValue = params[p3];
                const isPropValueArray = isArr(propValue);
                if (fastSet && !isPropValueArray) {
                  fastSetValuesArray[0] = propValue;
                  fastSetValuesArray[1] = propValue;
                  propValue = fastSetValuesArray;
                }
                if (isPropValueArray) {
                  const arrayLength = (
                    /** @type {Array} */
                    propValue.length
                  );
                  const isNotObjectValue = !isObj(propValue[0]);
                  if (arrayLength === 2 && isNotObjectValue) {
                    keyObjectTarget.to = /** @type {TweenParamValue} */
                    /** @type {unknown} */
                    propValue;
                    keyframesTargetArray[0] = keyObjectTarget;
                    keyframes = keyframesTargetArray;
                  } else if (arrayLength > 2 && isNotObjectValue) {
                    keyframes = [];
                    propValue.forEach((v3, i3) => {
                      if (!i3) {
                        fastSetValuesArray[0] = v3;
                      } else if (i3 === 1) {
                        fastSetValuesArray[1] = v3;
                        keyframes.push(fastSetValuesArray);
                      } else {
                        keyframes.push(v3);
                      }
                    });
                  } else {
                    keyframes = /** @type {Array.<TweenKeyValue>} */
                    propValue;
                  }
                } else {
                  keyframesTargetArray[0] = propValue;
                  keyframes = keyframesTargetArray;
                }
                let siblings = null;
                let prevTween = null;
                let firstTweenChangeStartTime = NaN;
                let lastTweenChangeEndTime = 0;
                let tweenIndex = 0;
                for (let l3 = keyframes.length; tweenIndex < l3; tweenIndex++) {
                  const keyframe = keyframes[tweenIndex];
                  if (isObj(keyframe)) {
                    key = keyframe;
                  } else {
                    keyObjectTarget.to = /** @type {TweenParamValue} */
                    keyframe;
                    key = keyObjectTarget;
                  }
                  toFunctionStore.func = null;
                  const computedToValue = getFunctionValue(key.to, target, ti, tl, toFunctionStore);
                  let tweenToValue;
                  if (isObj(computedToValue) && !isUnd(computedToValue.to)) {
                    key = computedToValue;
                    tweenToValue = computedToValue.to;
                  } else {
                    tweenToValue = computedToValue;
                  }
                  const tweenFromValue = getFunctionValue(key.from, target, ti, tl);
                  const keyEasing = key.ease;
                  const hasSpring2 = !isUnd(keyEasing) && !isUnd(
                    /** @type {Spring} */
                    keyEasing.ease
                  );
                  const tweenEasing = hasSpring2 ? (
                    /** @type {Spring} */
                    keyEasing.ease
                  ) : keyEasing || tEasing;
                  const tweenDuration = hasSpring2 ? (
                    /** @type {Spring} */
                    keyEasing.duration
                  ) : getFunctionValue(setValue(key.duration, l3 > 1 ? getFunctionValue(tDuration, target, ti, tl) / l3 : tDuration), target, ti, tl);
                  const tweenDelay = getFunctionValue(setValue(key.delay, !tweenIndex ? tDelay : 0), target, ti, tl);
                  const computedComposition = getFunctionValue(setValue(key.composition, tComposition), target, ti, tl);
                  const tweenComposition = isNum(computedComposition) ? computedComposition : compositionTypes[computedComposition];
                  const tweenModifier = key.modifier || tModifier;
                  const hasFromvalue = !isUnd(tweenFromValue);
                  const hasToValue = !isUnd(tweenToValue);
                  const isFromToArray = isArr(tweenToValue);
                  const isFromToValue = isFromToArray || hasFromvalue && hasToValue;
                  const tweenStartTime = prevTween ? lastTweenChangeEndTime + tweenDelay : tweenDelay;
                  const absoluteStartTime = absoluteOffsetTime + tweenStartTime;
                  if (!shouldTriggerRender && (hasFromvalue || isFromToArray)) shouldTriggerRender = 1;
                  let prevSibling = prevTween;
                  if (tweenComposition !== compositionTypes.none) {
                    if (!siblings) siblings = getTweenSiblings(target, propName);
                    let nextSibling = siblings._head;
                    while (nextSibling && !nextSibling._isOverridden && nextSibling._absoluteStartTime <= absoluteStartTime) {
                      prevSibling = nextSibling;
                      nextSibling = nextSibling._nextRep;
                      if (nextSibling && nextSibling._absoluteStartTime >= absoluteStartTime) {
                        while (nextSibling) {
                          overrideTween(nextSibling);
                          nextSibling = nextSibling._nextRep;
                        }
                      }
                    }
                  }
                  if (isFromToValue) {
                    decomposeRawValue(isFromToArray ? getFunctionValue(tweenToValue[0], target, ti, tl) : tweenFromValue, fromTargetObject);
                    decomposeRawValue(isFromToArray ? getFunctionValue(tweenToValue[1], target, ti, tl, toFunctionStore) : tweenToValue, toTargetObject);
                    if (fromTargetObject.t === valueTypes.NUMBER) {
                      if (prevSibling) {
                        if (prevSibling._valueType === valueTypes.UNIT) {
                          fromTargetObject.t = valueTypes.UNIT;
                          fromTargetObject.u = prevSibling._unit;
                        }
                      } else {
                        decomposeRawValue(
                          getOriginalAnimatableValue(target, propName, tweenType, animInlineStyles),
                          decomposedOriginalValue
                        );
                        if (decomposedOriginalValue.t === valueTypes.UNIT) {
                          fromTargetObject.t = valueTypes.UNIT;
                          fromTargetObject.u = decomposedOriginalValue.u;
                        }
                      }
                    }
                  } else {
                    if (hasToValue) {
                      decomposeRawValue(tweenToValue, toTargetObject);
                    } else {
                      if (prevTween) {
                        decomposeTweenValue(prevTween, toTargetObject);
                      } else {
                        decomposeRawValue(parent && prevSibling && prevSibling.parent.parent === parent ? prevSibling._value : getOriginalAnimatableValue(target, propName, tweenType, animInlineStyles), toTargetObject);
                      }
                    }
                    if (hasFromvalue) {
                      decomposeRawValue(tweenFromValue, fromTargetObject);
                    } else {
                      if (prevTween) {
                        decomposeTweenValue(prevTween, fromTargetObject);
                      } else {
                        decomposeRawValue(parent && prevSibling && prevSibling.parent.parent === parent ? prevSibling._value : (
                          // No need to get and parse the original value if the tween is part of a timeline and has a previous sibling part of the same timeline
                          getOriginalAnimatableValue(target, propName, tweenType, animInlineStyles)
                        ), fromTargetObject);
                      }
                    }
                  }
                  if (fromTargetObject.o) {
                    fromTargetObject.n = getRelativeValue(
                      !prevSibling ? decomposeRawValue(
                        getOriginalAnimatableValue(target, propName, tweenType, animInlineStyles),
                        decomposedOriginalValue
                      ).n : prevSibling._toNumber,
                      fromTargetObject.n,
                      fromTargetObject.o
                    );
                  }
                  if (toTargetObject.o) {
                    toTargetObject.n = getRelativeValue(fromTargetObject.n, toTargetObject.n, toTargetObject.o);
                  }
                  if (fromTargetObject.t !== toTargetObject.t) {
                    if (fromTargetObject.t === valueTypes.COMPLEX || toTargetObject.t === valueTypes.COMPLEX) {
                      const complexValue = fromTargetObject.t === valueTypes.COMPLEX ? fromTargetObject : toTargetObject;
                      const notComplexValue = fromTargetObject.t === valueTypes.COMPLEX ? toTargetObject : fromTargetObject;
                      notComplexValue.t = valueTypes.COMPLEX;
                      notComplexValue.s = cloneArray(complexValue.s);
                      notComplexValue.d = complexValue.d.map(() => notComplexValue.n);
                    } else if (fromTargetObject.t === valueTypes.UNIT || toTargetObject.t === valueTypes.UNIT) {
                      const unitValue = fromTargetObject.t === valueTypes.UNIT ? fromTargetObject : toTargetObject;
                      const notUnitValue = fromTargetObject.t === valueTypes.UNIT ? toTargetObject : fromTargetObject;
                      notUnitValue.t = valueTypes.UNIT;
                      notUnitValue.u = unitValue.u;
                    } else if (fromTargetObject.t === valueTypes.COLOR || toTargetObject.t === valueTypes.COLOR) {
                      const colorValue = fromTargetObject.t === valueTypes.COLOR ? fromTargetObject : toTargetObject;
                      const notColorValue = fromTargetObject.t === valueTypes.COLOR ? toTargetObject : fromTargetObject;
                      notColorValue.t = valueTypes.COLOR;
                      notColorValue.s = colorValue.s;
                      notColorValue.d = [0, 0, 0, 1];
                    }
                  }
                  if (fromTargetObject.u !== toTargetObject.u) {
                    let valueToConvert = toTargetObject.u ? fromTargetObject : toTargetObject;
                    valueToConvert = convertValueUnit(
                      /** @type {DOMTarget} */
                      target,
                      valueToConvert,
                      toTargetObject.u ? toTargetObject.u : fromTargetObject.u,
                      false
                    );
                  }
                  if (toTargetObject.d && fromTargetObject.d && toTargetObject.d.length !== fromTargetObject.d.length) {
                    const longestValue = fromTargetObject.d.length > toTargetObject.d.length ? fromTargetObject : toTargetObject;
                    const shortestValue = longestValue === fromTargetObject ? toTargetObject : fromTargetObject;
                    shortestValue.d = longestValue.d.map((_3, i3) => isUnd(shortestValue.d[i3]) ? 0 : shortestValue.d[i3]);
                    shortestValue.s = cloneArray(longestValue.s);
                  }
                  const tweenUpdateDuration = round(+tweenDuration || minValue, 12);
                  const tween = {
                    parent: this,
                    id: tweenId++,
                    property: propName,
                    target,
                    _value: null,
                    _func: toFunctionStore.func,
                    _ease: parseEasings(tweenEasing),
                    _fromNumbers: cloneArray(fromTargetObject.d),
                    _toNumbers: cloneArray(toTargetObject.d),
                    _strings: cloneArray(toTargetObject.s),
                    _fromNumber: fromTargetObject.n,
                    _toNumber: toTargetObject.n,
                    _numbers: cloneArray(fromTargetObject.d),
                    // For additive tween and animatables
                    _number: fromTargetObject.n,
                    // For additive tween and animatables
                    _unit: toTargetObject.u,
                    _modifier: tweenModifier,
                    _currentTime: 0,
                    _startTime: tweenStartTime,
                    _delay: +tweenDelay,
                    _updateDuration: tweenUpdateDuration,
                    _changeDuration: tweenUpdateDuration,
                    _absoluteStartTime: absoluteStartTime,
                    // NOTE: Investigate bit packing to stores ENUM / BOOL
                    _tweenType: tweenType,
                    _valueType: toTargetObject.t,
                    _composition: tweenComposition,
                    _isOverlapped: 0,
                    _isOverridden: 0,
                    _renderTransforms: 0,
                    _prevRep: null,
                    // For replaced tween
                    _nextRep: null,
                    // For replaced tween
                    _prevAdd: null,
                    // For additive tween
                    _nextAdd: null,
                    // For additive tween
                    _prev: null,
                    _next: null
                  };
                  if (tweenComposition !== compositionTypes.none) {
                    composeTween(tween, siblings);
                  }
                  if (isNaN(firstTweenChangeStartTime)) {
                    firstTweenChangeStartTime = tween._startTime;
                  }
                  lastTweenChangeEndTime = round(tweenStartTime + tweenUpdateDuration, 12);
                  prevTween = tween;
                  animationAnimationLength++;
                  addChild(this, tween);
                }
                if (isNaN(iterationDelay) || firstTweenChangeStartTime < iterationDelay) {
                  iterationDelay = firstTweenChangeStartTime;
                }
                if (isNaN(iterationDuration) || lastTweenChangeEndTime > iterationDuration) {
                  iterationDuration = lastTweenChangeEndTime;
                }
                if (tweenType === tweenTypes.TRANSFORM) {
                  lastTransformGroupIndex = animationAnimationLength - tweenIndex;
                  lastTransformGroupLength = animationAnimationLength;
                }
              }
            }
            if (!isNaN(lastTransformGroupIndex)) {
              let i3 = 0;
              forEachChildren(this, (tween) => {
                if (i3 >= lastTransformGroupIndex && i3 < lastTransformGroupLength) {
                  tween._renderTransforms = 1;
                  if (tween._composition === compositionTypes.blend) {
                    forEachChildren(additive.animation, (additiveTween) => {
                      if (additiveTween.id === tween.id) {
                        additiveTween._renderTransforms = 1;
                      }
                    });
                  }
                }
                i3++;
              });
            }
          }
          if (!targetsLength) {
            console.warn(`No target found. Make sure the element you're trying to animate is accessible before creating your animation.`);
          }
          if (iterationDelay) {
            forEachChildren(this, (tween) => {
              if (!(tween._startTime - tween._delay)) {
                tween._delay -= iterationDelay;
              }
              tween._startTime -= iterationDelay;
            });
            iterationDuration -= iterationDelay;
          } else {
            iterationDelay = 0;
          }
          if (!iterationDuration) {
            iterationDuration = minValue;
            this.iterationCount = 0;
          }
          this.targets = parsedTargets;
          this.duration = iterationDuration === minValue ? minValue : clampInfinity((iterationDuration + this._loopDelay) * this.iterationCount - this._loopDelay) || minValue;
          this.onRender = onRender || animDefaults.onRender;
          this._ease = animEase;
          this._delay = iterationDelay;
          this.iterationDuration = iterationDuration;
          this._inlineStyles = animInlineStyles;
          if (!this._autoplay && shouldTriggerRender) this.onRender(this);
        }
        /**
         * @param  {Number} newDuration
         * @return {this}
         */
        stretch(newDuration) {
          const currentDuration = this.duration;
          if (currentDuration === normalizeTime(newDuration)) return this;
          const timeScale = newDuration / currentDuration;
          forEachChildren(this, (tween) => {
            tween._updateDuration = normalizeTime(tween._updateDuration * timeScale);
            tween._changeDuration = normalizeTime(tween._changeDuration * timeScale);
            tween._currentTime *= timeScale;
            tween._startTime *= timeScale;
            tween._absoluteStartTime *= timeScale;
          });
          return super.stretch(newDuration);
        }
        /**
         * @return {this}
         */
        refresh() {
          forEachChildren(this, (tween) => {
            const tweenFunc = tween._func;
            if (tweenFunc) {
              const ogValue = getOriginalAnimatableValue(tween.target, tween.property, tween._tweenType);
              decomposeRawValue(ogValue, decomposedOriginalValue);
              decomposeRawValue(tweenFunc(), toTargetObject);
              tween._fromNumbers = cloneArray(decomposedOriginalValue.d);
              tween._fromNumber = decomposedOriginalValue.n;
              tween._toNumbers = cloneArray(toTargetObject.d);
              tween._strings = cloneArray(toTargetObject.s);
              tween._toNumber = toTargetObject.o ? getRelativeValue(decomposedOriginalValue.n, toTargetObject.n, toTargetObject.o) : toTargetObject.n;
            }
          });
          return this;
        }
        /**
         * Cancel the animation and revert all the values affected by this animation to their original state
         * @return {this}
         */
        revert() {
          super.revert();
          return cleanInlineStyles(this);
        }
        /**
         * @param  {Callback<this>} [callback]
         * @return {Promise}
         */
        then(callback) {
          return super.then(callback);
        }
      };
      animate = /* @__PURE__ */ __name((targets, parameters) => new JSAnimation(targets, parameters, null, 0, false).init(), "animate");
      transformsShorthands = ["x", "y", "z"];
      commonDefaultPXProperties = [
        "perspective",
        "width",
        "height",
        "margin",
        "padding",
        "top",
        "right",
        "bottom",
        "left",
        "borderWidth",
        "fontSize",
        "borderRadius",
        ...transformsShorthands
      ];
      WAAPIAnimationsLookups = {
        _head: null,
        _tail: null
      };
      removeWAAPIAnimation = /* @__PURE__ */ __name(($el, property, parent) => {
        let nextLookup = WAAPIAnimationsLookups._head;
        while (nextLookup) {
          const next = nextLookup._next;
          const matchTarget = nextLookup.$el === $el;
          const matchProperty = !property || nextLookup.property === property;
          const matchParent = !parent || nextLookup.parent === parent;
          if (matchTarget && matchProperty && matchParent) {
            const anim = nextLookup.animation;
            try {
              anim.commitStyles();
            } catch {
            }
            anim.cancel();
            removeChild(WAAPIAnimationsLookups, nextLookup);
            const lookupParent = nextLookup.parent;
            if (lookupParent) {
              lookupParent._completed++;
              if (lookupParent.animations.length === lookupParent._completed) {
                lookupParent.completed = true;
                if (!lookupParent.muteCallbacks) {
                  lookupParent.paused = true;
                  lookupParent.onComplete(lookupParent);
                  lookupParent._resolve(lookupParent);
                }
              }
            }
          }
          nextLookup = next;
        }
      }, "removeWAAPIAnimation");
      sync = /* @__PURE__ */ __name((callback = noop) => {
        return new Timer({ duration: 1 * globals.timeScale, onComplete: callback }, null, 0).resume();
      }, "sync");
      __name(getTargetValue, "getTargetValue");
      setTargetValues = /* @__PURE__ */ __name((targets, parameters) => {
        if (isUnd(parameters)) return;
        parameters.duration = minValue;
        parameters.composition = setValue(parameters.composition, compositionTypes.none);
        return new JSAnimation(targets, parameters, null, 0, true).resume();
      }, "setTargetValues");
      removeTargetsFromAnimation = /* @__PURE__ */ __name((targetsArray, animation, propertyName) => {
        let tweensMatchesTargets = false;
        forEachChildren(animation, (tween) => {
          const tweenTarget = tween.target;
          if (targetsArray.includes(tweenTarget)) {
            const tweenName = tween.property;
            const tweenType = tween._tweenType;
            const normalizePropName = sanitizePropertyName(propertyName, tweenTarget, tweenType);
            if (!normalizePropName || normalizePropName && normalizePropName === tweenName) {
              if (tween.parent._tail === tween && tween._tweenType === tweenTypes.TRANSFORM && tween._prev && tween._prev._tweenType === tweenTypes.TRANSFORM) {
                tween._prev._renderTransforms = 1;
              }
              removeChild(animation, tween);
              removeTweenSliblings(tween);
              tweensMatchesTargets = true;
            }
          }
        }, true);
        return tweensMatchesTargets;
      }, "removeTargetsFromAnimation");
      remove2 = /* @__PURE__ */ __name((targets, renderable, propertyName) => {
        const targetsArray = parseTargets(targets);
        const parent = (
          /** @type {Renderable|typeof engine} **/
          renderable ? renderable : engine
        );
        const waapiAnimation = renderable && /** @type {WAAPIAnimation} */
        renderable.controlAnimation && /** @type {WAAPIAnimation} */
        renderable;
        for (let i3 = 0, l3 = targetsArray.length; i3 < l3; i3++) {
          const $el = (
            /** @type {DOMTarget}  */
            targetsArray[i3]
          );
          removeWAAPIAnimation($el, propertyName, waapiAnimation);
        }
        let removeMatches;
        if (parent._hasChildren) {
          let iterationDuration = 0;
          forEachChildren(parent, (child) => {
            if (!child._hasChildren) {
              removeMatches = removeTargetsFromAnimation(
                targetsArray,
                /** @type {JSAnimation} */
                child,
                propertyName
              );
              if (removeMatches && !child._head) {
                child.cancel();
                removeChild(parent, child);
              } else {
                const childTLOffset = child._offset + child._delay;
                const childDur = childTLOffset + child.duration;
                if (childDur > iterationDuration) {
                  iterationDuration = childDur;
                }
              }
            }
            if (child._head) {
              remove2(targets, child, propertyName);
            } else {
              child._hasChildren = false;
            }
          }, true);
          if (!isUnd(
            /** @type {Renderable} */
            parent.iterationDuration
          )) {
            parent.iterationDuration = iterationDuration;
          }
        } else {
          removeMatches = removeTargetsFromAnimation(
            targetsArray,
            /** @type {JSAnimation} */
            parent,
            propertyName
          );
        }
        if (removeMatches && !parent._head) {
          parent._hasChildren = false;
          if (
            /** @type {Renderable} */
            parent.cancel
          ) parent.cancel();
        }
        return targetsArray;
      }, "remove");
      keepTime = createRefreshable;
      randomPick = /* @__PURE__ */ __name((items) => items[random(0, items.length - 1)], "randomPick");
      roundPad = /* @__PURE__ */ __name((v3, decimalLength) => (+v3).toFixed(decimalLength), "roundPad");
      padStart = /* @__PURE__ */ __name((v3, totalLength, padString) => `${v3}`.padStart(totalLength, padString), "padStart");
      padEnd = /* @__PURE__ */ __name((v3, totalLength, padString) => `${v3}`.padEnd(totalLength, padString), "padEnd");
      wrap = /* @__PURE__ */ __name((v3, min, max2) => ((v3 - min) % (max2 - min) + (max2 - min)) % (max2 - min) + min, "wrap");
      mapRange = /* @__PURE__ */ __name((value, inLow, inHigh, outLow, outHigh) => outLow + (value - inLow) / (inHigh - inLow) * (outHigh - outLow), "mapRange");
      degToRad = /* @__PURE__ */ __name((degrees) => degrees * PI / 180, "degToRad");
      radToDeg = /* @__PURE__ */ __name((radians) => radians * 180 / PI, "radToDeg");
      lerp = /* @__PURE__ */ __name((start, end, amount, renderable) => {
        let dt = K2 / globals.defaults.frameRate;
        if (renderable !== false) {
          const ticker = (
            /** @type Renderable */
            renderable || engine._hasChildren && engine
          );
          if (ticker && ticker.deltaTime) {
            dt = ticker.deltaTime;
          }
        }
        const t4 = 1 - Math.exp(-amount * dt * 0.1);
        return !amount ? start : amount === 1 ? end : (1 - t4) * start + t4 * end;
      }, "lerp");
      curry = /* @__PURE__ */ __name((fn2, last = 0) => (...args) => last ? (v3) => fn2(...args, v3) : (v3) => fn2(v3, ...args), "curry");
      chain = /* @__PURE__ */ __name((fn2) => {
        return (...args) => {
          const result = fn2(...args);
          return new Proxy(noop, {
            apply: /* @__PURE__ */ __name((_3, __, [v3]) => result(v3), "apply"),
            get: /* @__PURE__ */ __name((_3, prop) => chain(
              /**@param {...Number|String} nextArgs */
              (...nextArgs) => {
                const nextResult = utils[prop](...nextArgs);
                return (v3) => nextResult(result(v3));
              }
            ), "get")
          });
        };
      }, "chain");
      makeChainable = /* @__PURE__ */ __name((fn2, right = 0) => (...args) => (args.length < fn2.length ? chain(curry(fn2, right)) : fn2)(...args), "makeChainable");
      utils = {
        $: registerTargets,
        get: getTargetValue,
        set: setTargetValues,
        remove: remove2,
        cleanInlineStyles,
        random,
        randomPick,
        shuffle,
        lerp,
        sync,
        keepTime,
        clamp: (
          /** @type {typeof clamp & ChainedClamp} */
          makeChainable(clamp)
        ),
        round: (
          /** @type {typeof round & ChainedRound} */
          makeChainable(round)
        ),
        snap: (
          /** @type {typeof snap & ChainedSnap} */
          makeChainable(snap)
        ),
        wrap: (
          /** @type {typeof wrap & ChainedWrap} */
          makeChainable(wrap)
        ),
        interpolate: (
          /** @type {typeof interpolate & ChainedInterpolate} */
          makeChainable(interpolate, 1)
        ),
        mapRange: (
          /** @type {typeof mapRange & ChainedMapRange} */
          makeChainable(mapRange)
        ),
        roundPad: (
          /** @type {typeof roundPad & ChainedRoundPad} */
          makeChainable(roundPad)
        ),
        padStart: (
          /** @type {typeof padStart & ChainedPadStart} */
          makeChainable(padStart)
        ),
        padEnd: (
          /** @type {typeof padEnd & ChainedPadEnd} */
          makeChainable(padEnd)
        ),
        degToRad: (
          /** @type {typeof degToRad & ChainedDegToRad} */
          makeChainable(degToRad)
        ),
        radToDeg: (
          /** @type {typeof radToDeg & ChainedRadToDeg} */
          makeChainable(radToDeg)
        )
      };
      Animatable = class {
        static {
          __name(this, "Animatable");
        }
        /**
         * @param {TargetsParam} targets
         * @param {AnimatableParams} parameters
         */
        constructor(targets, parameters) {
          if (scope2.current) scope2.current.register(this);
          const globalParams = {};
          const properties = {};
          this.targets = [];
          this.animations = {};
          if (isUnd(targets) || isUnd(parameters)) return;
          for (let propName in parameters) {
            const paramValue = parameters[propName];
            if (isKey(propName)) {
              properties[propName] = paramValue;
            } else {
              globalParams[propName] = paramValue;
            }
          }
          for (let propName in properties) {
            const propValue = properties[propName];
            const isObjValue = isObj(propValue);
            let propParams = {};
            let to = "+=0";
            if (isObjValue) {
              const unit = propValue.unit;
              if (isStr(unit)) to += unit;
            } else {
              propParams.duration = propValue;
            }
            propParams[propName] = isObjValue ? mergeObjects({ to }, propValue) : to;
            const animParams = mergeObjects(globalParams, propParams);
            animParams.composition = compositionTypes.replace;
            animParams.autoplay = false;
            const animation = this.animations[propName] = new JSAnimation(targets, animParams, null, 0, false).init();
            if (!this.targets.length) this.targets.push(...animation.targets);
            this[propName] = (to2, duration, ease) => {
              const tween = (
                /** @type {Tween} */
                animation._head
              );
              if (isUnd(to2) && tween) {
                const numbers = tween._numbers;
                if (numbers && numbers.length) {
                  return numbers;
                } else {
                  return tween._modifier(tween._number);
                }
              } else {
                forEachChildren(animation, (tween2) => {
                  if (isArr(to2)) {
                    for (let i3 = 0, l3 = (
                      /** @type {Array} */
                      to2.length
                    ); i3 < l3; i3++) {
                      if (!isUnd(tween2._numbers[i3])) {
                        tween2._fromNumbers[i3] = /** @type {Number} */
                        tween2._modifier(tween2._numbers[i3]);
                        tween2._toNumbers[i3] = to2[i3];
                      }
                    }
                  } else {
                    tween2._fromNumber = /** @type {Number} */
                    tween2._modifier(tween2._number);
                    tween2._toNumber = /** @type {Number} */
                    to2;
                  }
                  if (!isUnd(ease)) tween2._ease = parseEasings(ease);
                  tween2._currentTime = 0;
                });
                if (!isUnd(duration)) animation.stretch(duration);
                animation.reset(1).resume();
                return this;
              }
            };
          }
        }
        revert() {
          for (let propName in this.animations) {
            this[propName] = noop;
            this.animations[propName].revert();
          }
          this.animations = {};
          this.targets.length = 0;
          return this;
        }
      };
      Spring = class {
        static {
          __name(this, "Spring");
        }
        /**
         * @param {SpringParams} [parameters]
         */
        constructor(parameters = {}) {
          this.timeStep = 0.02;
          this.restThreshold = 5e-4;
          this.restDuration = 200;
          this.maxDuration = 6e4;
          this.maxRestSteps = this.restDuration / this.timeStep / K2;
          this.maxIterations = this.maxDuration / this.timeStep / K2;
          this.m = clamp(setValue(parameters.mass, 1), 0, K2);
          this.s = clamp(setValue(parameters.stiffness, 100), 1, K2);
          this.d = clamp(setValue(parameters.damping, 10), 0.1, K2);
          this.v = clamp(setValue(parameters.velocity, 0), -1e3, K2);
          this.w0 = 0;
          this.zeta = 0;
          this.wd = 0;
          this.b = 0;
          this.solverDuration = 0;
          this.duration = 0;
          this.compute();
          this.ease = (t4) => t4 === 0 || t4 === 1 ? t4 : this.solve(t4 * this.solverDuration);
        }
        /** @type {EasingFunction} */
        solve(time) {
          const { zeta, w0, wd, b: b2 } = this;
          let t4 = time;
          if (zeta < 1) {
            t4 = exp(-t4 * zeta * w0) * (1 * cos(wd * t4) + b2 * sin(wd * t4));
          } else {
            t4 = (1 + b2 * t4) * exp(-t4 * w0);
          }
          return 1 - t4;
        }
        compute() {
          const { maxRestSteps, maxIterations, restThreshold, timeStep, m: m3, d: d3, s: s3, v: v3 } = this;
          const w0 = this.w0 = clamp(sqrt(s3 / m3), minValue, K2);
          const zeta = this.zeta = d3 / (2 * sqrt(s3 * m3));
          const wd = this.wd = zeta < 1 ? w0 * sqrt(1 - zeta * zeta) : 0;
          this.b = zeta < 1 ? (zeta * w0 + -v3) / wd : -v3 + w0;
          let solverTime = 0;
          let restSteps = 0;
          let iterations = 0;
          while (restSteps < maxRestSteps && iterations < maxIterations) {
            if (abs(1 - this.solve(solverTime)) < restThreshold) {
              restSteps++;
            } else {
              restSteps = 0;
            }
            this.solverDuration = solverTime;
            solverTime += timeStep;
            iterations++;
          }
          this.duration = round(this.solverDuration * K2, 0) * globals.timeScale;
        }
        get mass() {
          return this.m;
        }
        set mass(v3) {
          this.m = clamp(setValue(v3, 1), 0, K2);
          this.compute();
        }
        get stiffness() {
          return this.s;
        }
        set stiffness(v3) {
          this.s = clamp(setValue(v3, 100), 1, K2);
          this.compute();
        }
        get damping() {
          return this.d;
        }
        set damping(v3) {
          this.d = clamp(setValue(v3, 10), 0.1, K2);
          this.compute();
        }
        get velocity() {
          return this.v;
        }
        set velocity(v3) {
          this.v = clamp(setValue(v3, 0), -1e3, K2);
          this.compute();
        }
      };
      createSpring = /* @__PURE__ */ __name((parameters) => new Spring(parameters), "createSpring");
      preventDefault = /* @__PURE__ */ __name((e3) => {
        if (e3.cancelable) e3.preventDefault();
      }, "preventDefault");
      DOMProxy = class {
        static {
          __name(this, "DOMProxy");
        }
        /** @param {Object} el */
        constructor(el) {
          this.el = el;
          this.zIndex = 0;
          this.parentElement = null;
          this.classList = {
            add: noop,
            remove: noop
          };
        }
        get x() {
          return this.el.x || 0;
        }
        set x(v3) {
          this.el.x = v3;
        }
        get y() {
          return this.el.y || 0;
        }
        set y(v3) {
          this.el.y = v3;
        }
        get width() {
          return this.el.width || 0;
        }
        set width(v3) {
          this.el.width = v3;
        }
        get height() {
          return this.el.height || 0;
        }
        set height(v3) {
          this.el.height = v3;
        }
        getBoundingClientRect() {
          return {
            top: this.y,
            right: this.x,
            bottom: this.y + this.height,
            left: this.x + this.width
          };
        }
      };
      Transforms = class {
        static {
          __name(this, "Transforms");
        }
        /**
         * @param {DOMTarget|DOMProxy} $el
         */
        constructor($el) {
          this.$el = $el;
          this.inlineTransforms = [];
          this.point = new DOMPoint();
          this.inversedMatrix = this.getMatrix().inverse();
        }
        /**
         * @param {Number} x
         * @param {Number} y
         * @return {DOMPoint}
         */
        normalizePoint(x4, y3) {
          this.point.x = x4;
          this.point.y = y3;
          return this.point.matrixTransform(this.inversedMatrix);
        }
        /**
         * @callback TraverseParentsCallback
         * @param {DOMTarget} $el
         * @param {Number} i
         */
        /**
         * @param {TraverseParentsCallback} cb
         */
        traverseUp(cb) {
          let $el = (
            /** @type {DOMTarget|Document} */
            this.$el.parentElement
          ), i3 = 0;
          while ($el && $el !== doc) {
            cb(
              /** @type {DOMTarget} */
              $el,
              i3
            );
            $el = /** @type {DOMTarget} */
            $el.parentElement;
            i3++;
          }
        }
        getMatrix() {
          const matrix = new DOMMatrix();
          this.traverseUp(($el) => {
            const transformValue = getComputedStyle($el).transform;
            if (transformValue) {
              const elMatrix = new DOMMatrix(transformValue);
              matrix.preMultiplySelf(elMatrix);
            }
          });
          return matrix;
        }
        remove() {
          this.traverseUp(($el, i3) => {
            this.inlineTransforms[i3] = $el.style.transform;
            $el.style.transform = "none";
          });
        }
        revert() {
          this.traverseUp(($el, i3) => {
            const ct = this.inlineTransforms[i3];
            if (ct === "") {
              $el.style.removeProperty("transform");
            } else {
              $el.style.transform = ct;
            }
          });
        }
      };
      parseDraggableFunctionParameter = /* @__PURE__ */ __name((value, draggable) => value && isFnc(value) ? (
        /** @type {Function} */
        value(draggable)
      ) : value, "parseDraggableFunctionParameter");
      zIndex = 0;
      Draggable = class {
        static {
          __name(this, "Draggable");
        }
        /**
         * @param {TargetsParam} target
         * @param {DraggableParams} [parameters]
         */
        constructor(target, parameters = {}) {
          if (!target) return;
          if (scope2.current) scope2.current.register(this);
          const paramX = parameters.x;
          const paramY = parameters.y;
          const trigger = parameters.trigger;
          const modifier = parameters.modifier;
          const ease = parameters.releaseEase;
          const customEase = ease && parseEasings(ease);
          const hasSpring = !isUnd(ease) && !isUnd(
            /** @type {Spring} */
            ease.ease
          );
          const xProp = (
            /** @type {String} */
            isObj(paramX) && !isUnd(
              /** @type {Object} */
              paramX.mapTo
            ) ? (
              /** @type {Object} */
              paramX.mapTo
            ) : "translateX"
          );
          const yProp = (
            /** @type {String} */
            isObj(paramY) && !isUnd(
              /** @type {Object} */
              paramY.mapTo
            ) ? (
              /** @type {Object} */
              paramY.mapTo
            ) : "translateY"
          );
          const container = parseDraggableFunctionParameter(parameters.container, this);
          this.containerArray = isArr(container) ? container : null;
          this.$container = /** @type {HTMLElement} */
          container && !this.containerArray ? parseTargets(
            /** @type {DOMTarget} */
            container
          )[0] : doc.body;
          this.useWin = this.$container === doc.body;
          this.$scrollContainer = this.useWin ? win : this.$container;
          this.$target = /** @type {HTMLElement} */
          isObj(target) ? new DOMProxy(target) : parseTargets(target)[0];
          this.$trigger = /** @type {HTMLElement} */
          parseTargets(trigger ? trigger : target)[0];
          this.fixed = getTargetValue(this.$target, "position") === "fixed";
          this.isFinePointer = true;
          this.containerPadding = [0, 0, 0, 0];
          this.containerFriction = 0;
          this.releaseContainerFriction = 0;
          this.snapX = 0;
          this.snapY = 0;
          this.scrollSpeed = 0;
          this.scrollThreshold = 0;
          this.dragSpeed = 0;
          this.maxVelocity = 0;
          this.minVelocity = 0;
          this.velocityMultiplier = 0;
          this.cursor = false;
          this.releaseXSpring = hasSpring ? (
            /** @type {Spring} */
            ease
          ) : createSpring({
            mass: setValue(parameters.releaseMass, 1),
            stiffness: setValue(parameters.releaseStiffness, 80),
            damping: setValue(parameters.releaseDamping, 20)
          });
          this.releaseYSpring = hasSpring ? (
            /** @type {Spring} */
            ease
          ) : createSpring({
            mass: setValue(parameters.releaseMass, 1),
            stiffness: setValue(parameters.releaseStiffness, 80),
            damping: setValue(parameters.releaseDamping, 20)
          });
          this.releaseEase = customEase || eases.outQuint;
          this.hasReleaseSpring = hasSpring;
          this.onGrab = parameters.onGrab || noop;
          this.onDrag = parameters.onDrag || noop;
          this.onRelease = parameters.onRelease || noop;
          this.onUpdate = parameters.onUpdate || noop;
          this.onSettle = parameters.onSettle || noop;
          this.onSnap = parameters.onSnap || noop;
          this.onResize = parameters.onResize || noop;
          this.onAfterResize = parameters.onAfterResize || noop;
          this.disabled = [0, 0];
          const animatableParams = {};
          if (modifier) animatableParams.modifier = modifier;
          if (isUnd(paramX) || paramX === true) {
            animatableParams[xProp] = 0;
          } else if (isObj(paramX)) {
            const paramXObject = (
              /** @type {DraggableAxisParam} */
              paramX
            );
            const animatableXParams = {};
            if (paramXObject.modifier) animatableXParams.modifier = paramXObject.modifier;
            if (paramXObject.composition) animatableXParams.composition = paramXObject.composition;
            animatableParams[xProp] = animatableXParams;
          } else if (paramX === false) {
            animatableParams[xProp] = 0;
            this.disabled[0] = 1;
          }
          if (isUnd(paramY) || paramY === true) {
            animatableParams[yProp] = 0;
          } else if (isObj(paramY)) {
            const paramYObject = (
              /** @type {DraggableAxisParam} */
              paramY
            );
            const animatableYParams = {};
            if (paramYObject.modifier) animatableYParams.modifier = paramYObject.modifier;
            if (paramYObject.composition) animatableYParams.composition = paramYObject.composition;
            animatableParams[yProp] = animatableYParams;
          } else if (paramY === false) {
            animatableParams[yProp] = 0;
            this.disabled[1] = 1;
          }
          this.animate = /** @type {AnimatableObject} */
          new Animatable(this.$target, animatableParams);
          this.xProp = xProp;
          this.yProp = yProp;
          this.destX = 0;
          this.destY = 0;
          this.deltaX = 0;
          this.deltaY = 0;
          this.scroll = { x: 0, y: 0 };
          this.coords = [this.x, this.y, 0, 0];
          this.snapped = [0, 0];
          this.pointer = [0, 0, 0, 0, 0, 0, 0, 0];
          this.scrollView = [0, 0];
          this.dragArea = [0, 0, 0, 0];
          this.containerBounds = [-1e12, maxValue, maxValue, -1e12];
          this.scrollBounds = [0, 0, 0, 0];
          this.targetBounds = [0, 0, 0, 0];
          this.window = [0, 0];
          this.velocityStack = [0, 0, 0];
          this.velocityStackIndex = 0;
          this.velocityTime = now();
          this.velocity = 0;
          this.angle = 0;
          this.cursorStyles = null;
          this.triggerStyles = null;
          this.bodyStyles = null;
          this.targetStyles = null;
          this.touchActionStyles = null;
          this.transforms = new Transforms(this.$target);
          this.overshootCoords = { x: 0, y: 0 };
          this.overshootXTicker = new Timer({ autoplay: false }, null, 0).init();
          this.overshootYTicker = new Timer({ autoplay: false }, null, 0).init();
          this.updateTicker = new Timer({ autoplay: false }, null, 0).init();
          this.overshootXTicker.onUpdate = () => {
            if (this.disabled[0]) return;
            this.updated = true;
            this.manual = true;
            this.animate[this.xProp](this.overshootCoords.x, 0);
          };
          this.overshootXTicker.onComplete = () => {
            if (this.disabled[0]) return;
            this.manual = false;
            this.animate[this.xProp](this.overshootCoords.x, 0);
          };
          this.overshootYTicker.onUpdate = () => {
            if (this.disabled[1]) return;
            this.updated = true;
            this.manual = true;
            this.animate[this.yProp](this.overshootCoords.y, 0);
          };
          this.overshootYTicker.onComplete = () => {
            if (this.disabled[1]) return;
            this.manual = false;
            this.animate[this.yProp](this.overshootCoords.y, 0);
          };
          this.updateTicker.onUpdate = () => this.update();
          this.contained = !isUnd(container);
          this.manual = false;
          this.grabbed = false;
          this.dragged = false;
          this.updated = false;
          this.released = false;
          this.canScroll = false;
          this.enabled = false;
          this.initialized = false;
          this.activeProp = this.disabled[1] ? xProp : yProp;
          this.animate.animations[this.activeProp].onRender = () => {
            const hasUpdated = this.updated;
            const hasMoved = this.grabbed && hasUpdated;
            const hasReleased = !hasMoved && this.released;
            const x4 = this.x;
            const y3 = this.y;
            const dx = x4 - this.coords[2];
            const dy = y3 - this.coords[3];
            this.deltaX = dx;
            this.deltaY = dy;
            this.coords[2] = x4;
            this.coords[3] = y3;
            if (hasUpdated && (dx || dy)) {
              this.onUpdate(this);
            }
            if (!hasReleased) {
              this.updated = false;
            } else {
              this.computeVelocity(dx, dy);
              this.angle = atan2(dy, dx);
            }
          };
          this.animate.animations[this.activeProp].onComplete = () => {
            if (!this.grabbed && this.released) {
              this.released = false;
            }
            if (!this.manual) {
              this.deltaX = 0;
              this.deltaY = 0;
              this.velocity = 0;
              this.velocityStack[0] = 0;
              this.velocityStack[1] = 0;
              this.velocityStack[2] = 0;
              this.velocityStackIndex = 0;
              this.onSettle(this);
            }
          };
          this.resizeTicker = new Timer({
            autoplay: false,
            duration: 150 * globals.timeScale,
            onComplete: /* @__PURE__ */ __name(() => {
              this.onResize(this);
              this.refresh();
              this.onAfterResize(this);
            }, "onComplete")
          }).init();
          this.parameters = parameters;
          this.resizeObserver = new ResizeObserver(() => {
            if (this.initialized) {
              this.resizeTicker.restart();
            } else {
              this.initialized = true;
            }
          });
          this.enable();
          this.refresh();
          this.resizeObserver.observe(this.$container);
          if (!isObj(target)) this.resizeObserver.observe(this.$target);
        }
        /**
         * @param  {Number} dx
         * @param  {Number} dy
         * @return {Number}
         */
        computeVelocity(dx, dy) {
          const prevTime = this.velocityTime;
          const curTime = now();
          const elapsed = curTime - prevTime;
          if (elapsed < 17) return this.velocity;
          this.velocityTime = curTime;
          const velocityStack = this.velocityStack;
          const vMul = this.velocityMultiplier;
          const minV = this.minVelocity;
          const maxV = this.maxVelocity;
          const vi = this.velocityStackIndex;
          velocityStack[vi] = round(clamp(sqrt(dx * dx + dy * dy) / elapsed * vMul, minV, maxV), 5);
          const velocity = max(velocityStack[0], velocityStack[1], velocityStack[2]);
          this.velocity = velocity;
          this.velocityStackIndex = (vi + 1) % 3;
          return velocity;
        }
        /**
         * @param {Number}  x
         * @param {Boolean} [muteUpdateCallback]
         * @return {this}
         */
        setX(x4, muteUpdateCallback = false) {
          if (this.disabled[0]) return;
          const v3 = round(x4, 5);
          this.overshootXTicker.pause();
          this.manual = true;
          this.updated = !muteUpdateCallback;
          this.destX = v3;
          this.snapped[0] = snap(v3, this.snapX);
          this.animate[this.xProp](v3, 0);
          this.manual = false;
          return this;
        }
        /**
         * @param {Number}  y
         * @param {Boolean} [muteUpdateCallback]
         * @return {this}
         */
        setY(y3, muteUpdateCallback = false) {
          if (this.disabled[1]) return;
          const v3 = round(y3, 5);
          this.overshootYTicker.pause();
          this.manual = true;
          this.updated = !muteUpdateCallback;
          this.destY = v3;
          this.snapped[1] = snap(v3, this.snapY);
          this.animate[this.yProp](v3, 0);
          this.manual = false;
          return this;
        }
        get x() {
          return round(
            /** @type {Number} */
            this.animate[this.xProp](),
            globals.precision
          );
        }
        set x(x4) {
          this.setX(x4, false);
        }
        get y() {
          return round(
            /** @type {Number} */
            this.animate[this.yProp](),
            globals.precision
          );
        }
        set y(y3) {
          this.setY(y3, false);
        }
        get progressX() {
          return mapRange(this.x, this.containerBounds[3], this.containerBounds[1], 0, 1);
        }
        set progressX(x4) {
          this.setX(mapRange(x4, 0, 1, this.containerBounds[3], this.containerBounds[1]), false);
        }
        get progressY() {
          return mapRange(this.y, this.containerBounds[0], this.containerBounds[2], 0, 1);
        }
        set progressY(y3) {
          this.setY(mapRange(y3, 0, 1, this.containerBounds[0], this.containerBounds[2]), false);
        }
        updateScrollCoords() {
          const sx = round(this.useWin ? win.scrollX : this.$container.scrollLeft, 0);
          const sy = round(this.useWin ? win.scrollY : this.$container.scrollTop, 0);
          const [cpt, cpr, cpb, cpl] = this.containerPadding;
          const threshold = this.scrollThreshold;
          this.scroll.x = sx;
          this.scroll.y = sy;
          this.scrollBounds[0] = sy - this.targetBounds[0] + cpt - threshold;
          this.scrollBounds[1] = sx - this.targetBounds[1] - cpr + threshold;
          this.scrollBounds[2] = sy - this.targetBounds[2] - cpb + threshold;
          this.scrollBounds[3] = sx - this.targetBounds[3] + cpl - threshold;
        }
        updateBoundingValues() {
          const $container = this.$container;
          const cx = this.x;
          const cy = this.y;
          const cx2 = this.coords[2];
          const cy2 = this.coords[3];
          this.coords[2] = 0;
          this.coords[3] = 0;
          this.setX(0, true);
          this.setY(0, true);
          this.transforms.remove();
          const iw = this.window[0] = win.innerWidth;
          const ih = this.window[1] = win.innerHeight;
          const uw = this.useWin;
          const sw = $container.scrollWidth;
          const sh = $container.scrollHeight;
          const fx = this.fixed;
          const transformContainerRect = $container.getBoundingClientRect();
          const [cpt, cpr, cpb, cpl] = this.containerPadding;
          this.dragArea[0] = uw ? 0 : transformContainerRect.left;
          this.dragArea[1] = uw ? 0 : transformContainerRect.top;
          this.scrollView[0] = uw ? clamp(sw, iw, sw) : sw;
          this.scrollView[1] = uw ? clamp(sh, ih, sh) : sh;
          this.updateScrollCoords();
          const { width, height, left, top, right, bottom } = $container.getBoundingClientRect();
          this.dragArea[2] = round(uw ? clamp(width, iw, iw) : width, 0);
          this.dragArea[3] = round(uw ? clamp(height, ih, ih) : height, 0);
          const containerOverflow = getTargetValue($container, "overflow");
          const visibleOverflow = containerOverflow === "visible";
          const hiddenOverflow = containerOverflow === "hidden";
          this.canScroll = fx ? false : this.contained && ($container === doc.body && visibleOverflow || !hiddenOverflow && !visibleOverflow) && (sw > this.dragArea[2] + cpl - cpr || sh > this.dragArea[3] + cpt - cpb) && (!this.containerArray || this.containerArray && !isArr(this.containerArray));
          if (this.contained) {
            const sx = this.scroll.x;
            const sy = this.scroll.y;
            const canScroll = this.canScroll;
            const targetRect = this.$target.getBoundingClientRect();
            const hiddenLeft = canScroll ? uw ? 0 : $container.scrollLeft : 0;
            const hiddenTop = canScroll ? uw ? 0 : $container.scrollTop : 0;
            const hiddenRight = canScroll ? this.scrollView[0] - hiddenLeft - width : 0;
            const hiddenBottom = canScroll ? this.scrollView[1] - hiddenTop - height : 0;
            this.targetBounds[0] = round(targetRect.top + sy - (uw ? 0 : top), 0);
            this.targetBounds[1] = round(targetRect.right + sx - (uw ? iw : right), 0);
            this.targetBounds[2] = round(targetRect.bottom + sy - (uw ? ih : bottom), 0);
            this.targetBounds[3] = round(targetRect.left + sx - (uw ? 0 : left), 0);
            if (this.containerArray) {
              this.containerBounds[0] = this.containerArray[0] + cpt;
              this.containerBounds[1] = this.containerArray[1] - cpr;
              this.containerBounds[2] = this.containerArray[2] - cpb;
              this.containerBounds[3] = this.containerArray[3] + cpl;
            } else {
              this.containerBounds[0] = -round(targetRect.top - (fx ? clamp(top, 0, ih) : top) + hiddenTop - cpt, 0);
              this.containerBounds[1] = -round(targetRect.right - (fx ? clamp(right, 0, iw) : right) - hiddenRight + cpr, 0);
              this.containerBounds[2] = -round(targetRect.bottom - (fx ? clamp(bottom, 0, ih) : bottom) - hiddenBottom + cpb, 0);
              this.containerBounds[3] = -round(targetRect.left - (fx ? clamp(left, 0, iw) : left) + hiddenLeft - cpl, 0);
            }
          }
          this.transforms.revert();
          this.coords[2] = cx2;
          this.coords[3] = cy2;
          this.setX(cx, true);
          this.setY(cy, true);
        }
        /**
         * Returns 0 if not OB, 1 if x is OB, 2 if y is OB, 3 if both x and y are OB
         *
         * @param  {Array} bounds
         * @param  {Number} x
         * @param  {Number} y
         * @return {Number}
         */
        isOutOfBounds(bounds, x4, y3) {
          if (!this.contained) return 0;
          const [bt, br2, bb, bl] = bounds;
          const [dx, dy] = this.disabled;
          const obx = !dx && x4 < bl || !dx && x4 > br2;
          const oby = !dy && y3 < bt || !dy && y3 > bb;
          return obx && !oby ? 1 : !obx && oby ? 2 : obx && oby ? 3 : 0;
        }
        refresh() {
          const params = this.parameters;
          const paramX = params.x;
          const paramY = params.y;
          const container = parseDraggableFunctionParameter(params.container, this);
          const cp = parseDraggableFunctionParameter(params.containerPadding, this) || 0;
          const containerPadding = (
            /** @type {[Number, Number, Number, Number]} */
            isArr(cp) ? cp : [cp, cp, cp, cp]
          );
          const cx = this.x;
          const cy = this.y;
          const parsedCursorStyles = parseDraggableFunctionParameter(params.cursor, this);
          const cursorStyles = { onHover: "grab", onGrab: "grabbing" };
          if (parsedCursorStyles) {
            const { onHover, onGrab } = (
              /** @type {DraggableCursorParams} */
              parsedCursorStyles
            );
            if (onHover) cursorStyles.onHover = onHover;
            if (onGrab) cursorStyles.onGrab = onGrab;
          }
          this.containerArray = isArr(container) ? container : null;
          this.$container = /** @type {HTMLElement} */
          container && !this.containerArray ? parseTargets(
            /** @type {DOMTarget} */
            container
          )[0] : doc.body;
          this.useWin = this.$container === doc.body;
          this.$scrollContainer = this.useWin ? win : this.$container;
          this.isFinePointer = matchMedia("(pointer:fine)").matches;
          this.containerPadding = setValue(containerPadding, [0, 0, 0, 0]);
          this.containerFriction = clamp(setValue(parseDraggableFunctionParameter(params.containerFriction, this), 0.8), 0, 1);
          this.releaseContainerFriction = clamp(setValue(parseDraggableFunctionParameter(params.releaseContainerFriction, this), this.containerFriction), 0, 1);
          this.snapX = parseDraggableFunctionParameter(isObj(paramX) && !isUnd(paramX.snap) ? paramX.snap : params.snap, this);
          this.snapY = parseDraggableFunctionParameter(isObj(paramY) && !isUnd(paramY.snap) ? paramY.snap : params.snap, this);
          this.scrollSpeed = setValue(parseDraggableFunctionParameter(params.scrollSpeed, this), 1.5);
          this.scrollThreshold = setValue(parseDraggableFunctionParameter(params.scrollThreshold, this), 20);
          this.dragSpeed = setValue(parseDraggableFunctionParameter(params.dragSpeed, this), 1);
          this.minVelocity = setValue(parseDraggableFunctionParameter(params.minVelocity, this), 0);
          this.maxVelocity = setValue(parseDraggableFunctionParameter(params.maxVelocity, this), 50);
          this.velocityMultiplier = setValue(parseDraggableFunctionParameter(params.velocityMultiplier, this), 1);
          this.cursor = parsedCursorStyles === false ? false : cursorStyles;
          this.updateBoundingValues();
          const [bt, br2, bb, bl] = this.containerBounds;
          this.setX(clamp(cx, bl, br2), true);
          this.setY(clamp(cy, bt, bb), true);
        }
        update() {
          this.updateScrollCoords();
          if (this.canScroll) {
            const [cpt, cpr, cpb, cpl] = this.containerPadding;
            const [sw, sh] = this.scrollView;
            const daw = this.dragArea[2];
            const dah = this.dragArea[3];
            const csx = this.scroll.x;
            const csy = this.scroll.y;
            const nsw = this.$container.scrollWidth;
            const nsh = this.$container.scrollHeight;
            const csw = this.useWin ? clamp(nsw, this.window[0], nsw) : nsw;
            const csh = this.useWin ? clamp(nsh, this.window[1], nsh) : nsh;
            const swd = sw - csw;
            const shd = sh - csh;
            if (this.dragged && swd > 0) {
              this.coords[0] -= swd;
              this.scrollView[0] = csw;
            }
            if (this.dragged && shd > 0) {
              this.coords[1] -= shd;
              this.scrollView[1] = csh;
            }
            const s3 = this.scrollSpeed * 10;
            const threshold = this.scrollThreshold;
            const [x4, y3] = this.coords;
            const [st, sr, sb, sl] = this.scrollBounds;
            const t4 = round(clamp((y3 - st + cpt) / threshold, -1, 0) * s3, 0);
            const r3 = round(clamp((x4 - sr - cpr) / threshold, 0, 1) * s3, 0);
            const b2 = round(clamp((y3 - sb - cpb) / threshold, 0, 1) * s3, 0);
            const l3 = round(clamp((x4 - sl + cpl) / threshold, -1, 0) * s3, 0);
            if (t4 || b2 || l3 || r3) {
              const [nx, ny] = this.disabled;
              let scrollX = csx;
              let scrollY = csy;
              if (!nx) {
                scrollX = round(clamp(csx + (l3 || r3), 0, sw - daw), 0);
                this.coords[0] -= csx - scrollX;
              }
              if (!ny) {
                scrollY = round(clamp(csy + (t4 || b2), 0, sh - dah), 0);
                this.coords[1] -= csy - scrollY;
              }
              if (this.useWin) {
                this.$scrollContainer.scrollBy(-(csx - scrollX), -(csy - scrollY));
              } else {
                this.$scrollContainer.scrollTo(scrollX, scrollY);
              }
            }
          }
          const [ct, cr, cb, cl] = this.containerBounds;
          const [px1, py1, px2, py2, px3, py3] = this.pointer;
          this.coords[0] += (px1 - px3) * this.dragSpeed;
          this.coords[1] += (py1 - py3) * this.dragSpeed;
          this.pointer[4] = px1;
          this.pointer[5] = py1;
          const [cx, cy] = this.coords;
          const [sx, sy] = this.snapped;
          const cf = (1 - this.containerFriction) * this.dragSpeed;
          this.setX(cx > cr ? cr + (cx - cr) * cf : cx < cl ? cl + (cx - cl) * cf : cx, false);
          this.setY(cy > cb ? cb + (cy - cb) * cf : cy < ct ? ct + (cy - ct) * cf : cy, false);
          this.computeVelocity(px1 - px3, py1 - py3);
          this.angle = atan2(py1 - py2, px1 - px2);
          const [nsx, nsy] = this.snapped;
          if (nsx !== sx && this.snapX || nsy !== sy && this.snapY) {
            this.onSnap(this);
          }
        }
        stop() {
          this.updateTicker.pause();
          this.overshootXTicker.pause();
          this.overshootYTicker.pause();
          for (let prop in this.animate.animations) this.animate.animations[prop].pause();
          remove2(this, null, "x");
          remove2(this, null, "y");
          remove2(this, null, "progressX");
          remove2(this, null, "progressY");
          remove2(this.scroll);
          remove2(this.overshootCoords);
          return this;
        }
        /**
         * @param {Number} [duration]
         * @param {Number} [gap]
         * @param {EasingParam} [ease]
         * @return {this}
         */
        scrollInView(duration, gap = 0, ease = eases.inOutQuad) {
          this.updateScrollCoords();
          const x4 = this.destX;
          const y3 = this.destY;
          const scroll = this.scroll;
          const scrollBounds = this.scrollBounds;
          const canScroll = this.canScroll;
          if (!this.containerArray && this.isOutOfBounds(scrollBounds, x4, y3)) {
            const [st, sr, sb, sl] = scrollBounds;
            const t4 = round(clamp(y3 - st, -1e12, 0), 0);
            const r3 = round(clamp(x4 - sr, 0, maxValue), 0);
            const b2 = round(clamp(y3 - sb, 0, maxValue), 0);
            const l3 = round(clamp(x4 - sl, -1e12, 0), 0);
            new JSAnimation(scroll, {
              x: round(scroll.x + (l3 ? l3 - gap : r3 ? r3 + gap : 0), 0),
              y: round(scroll.y + (t4 ? t4 - gap : b2 ? b2 + gap : 0), 0),
              duration: isUnd(duration) ? 350 * globals.timeScale : duration,
              ease,
              onUpdate: /* @__PURE__ */ __name(() => {
                this.canScroll = false;
                this.$scrollContainer.scrollTo(scroll.x, scroll.y);
              }, "onUpdate")
            }).init().then(() => {
              this.canScroll = canScroll;
            });
          }
          return this;
        }
        handleHover() {
          if (this.isFinePointer && this.cursor && !this.cursorStyles) {
            this.cursorStyles = setTargetValues(this.$trigger, {
              cursor: (
                /** @type {DraggableCursorParams} */
                this.cursor.onHover
              )
            });
          }
        }
        /**
         * @param  {Number} [duration]
         * @param  {Number} [gap]
         * @param  {EasingParam} [ease]
         * @return {this}
         */
        animateInView(duration, gap = 0, ease = eases.inOutQuad) {
          this.stop();
          this.updateBoundingValues();
          const x4 = this.x;
          const y3 = this.y;
          const [cpt, cpr, cpb, cpl] = this.containerPadding;
          const bt = this.scroll.y - this.targetBounds[0] + cpt + gap;
          const br2 = this.scroll.x - this.targetBounds[1] - cpr - gap;
          const bb = this.scroll.y - this.targetBounds[2] - cpb - gap;
          const bl = this.scroll.x - this.targetBounds[3] + cpl + gap;
          const ob = this.isOutOfBounds([bt, br2, bb, bl], x4, y3);
          if (ob) {
            const [disabledX, disabledY] = this.disabled;
            const destX = clamp(snap(x4, this.snapX), bl, br2);
            const destY = clamp(snap(y3, this.snapY), bt, bb);
            const dur = isUnd(duration) ? 350 * globals.timeScale : duration;
            if (!disabledX && (ob === 1 || ob === 3)) this.animate[this.xProp](destX, dur, ease);
            if (!disabledY && (ob === 2 || ob === 3)) this.animate[this.yProp](destY, dur, ease);
          }
          return this;
        }
        /**
         * @param {MouseEvent|TouchEvent} e
         */
        handleDown(e3) {
          const $eTarget = (
            /** @type {HTMLElement} */
            e3.target
          );
          if (this.grabbed || /** @type {HTMLInputElement}  */
          $eTarget.type === "range") return;
          e3.stopPropagation();
          this.grabbed = true;
          this.released = false;
          this.stop();
          this.updateBoundingValues();
          const touches = (
            /** @type {TouchEvent} */
            e3.changedTouches
          );
          const eventX = touches ? touches[0].clientX : (
            /** @type {MouseEvent} */
            e3.clientX
          );
          const eventY = touches ? touches[0].clientY : (
            /** @type {MouseEvent} */
            e3.clientY
          );
          const { x: x4, y: y3 } = this.transforms.normalizePoint(eventX, eventY);
          const [ct, cr, cb, cl] = this.containerBounds;
          const cf = (1 - this.containerFriction) * this.dragSpeed;
          const cx = this.x;
          const cy = this.y;
          this.coords[0] = this.coords[2] = !cf ? cx : cx > cr ? cr + (cx - cr) / cf : cx < cl ? cl + (cx - cl) / cf : cx;
          this.coords[1] = this.coords[3] = !cf ? cy : cy > cb ? cb + (cy - cb) / cf : cy < ct ? ct + (cy - ct) / cf : cy;
          this.pointer[0] = x4;
          this.pointer[1] = y3;
          this.pointer[2] = x4;
          this.pointer[3] = y3;
          this.pointer[4] = x4;
          this.pointer[5] = y3;
          this.pointer[6] = x4;
          this.pointer[7] = y3;
          this.deltaX = 0;
          this.deltaY = 0;
          this.velocity = 0;
          this.velocityStack[0] = 0;
          this.velocityStack[1] = 0;
          this.velocityStack[2] = 0;
          this.velocityStackIndex = 0;
          this.angle = 0;
          if (this.targetStyles) {
            this.targetStyles.revert();
            this.targetStyles = null;
          }
          const z4 = (
            /** @type {Number} */
            getTargetValue(this.$target, "zIndex", false)
          );
          zIndex = (z4 > zIndex ? z4 : zIndex) + 1;
          this.targetStyles = setTargetValues(this.$target, { zIndex });
          if (this.triggerStyles) {
            this.triggerStyles.revert();
            this.triggerStyles = null;
          }
          if (this.cursorStyles) {
            this.cursorStyles.revert();
            this.cursorStyles = null;
          }
          if (this.isFinePointer && this.cursor) {
            this.bodyStyles = setTargetValues(doc.body, {
              cursor: (
                /** @type {DraggableCursorParams} */
                this.cursor.onGrab
              )
            });
          }
          this.scrollInView(100, 0, eases.out(3));
          this.onGrab(this);
          doc.addEventListener("touchmove", this);
          doc.addEventListener("touchend", this);
          doc.addEventListener("touchcancel", this);
          doc.addEventListener("mousemove", this);
          doc.addEventListener("mouseup", this);
          doc.addEventListener("selectstart", this);
        }
        /**
         * @param {MouseEvent|TouchEvent} e
         */
        handleMove(e3) {
          if (!this.grabbed) return;
          const touches = (
            /** @type {TouchEvent} */
            e3.changedTouches
          );
          const eventX = touches ? touches[0].clientX : (
            /** @type {MouseEvent} */
            e3.clientX
          );
          const eventY = touches ? touches[0].clientY : (
            /** @type {MouseEvent} */
            e3.clientY
          );
          const { x: x4, y: y3 } = this.transforms.normalizePoint(eventX, eventY);
          const movedX = x4 - this.pointer[6];
          const movedY = y3 - this.pointer[7];
          let $parent = (
            /** @type {HTMLElement} */
            e3.target
          );
          let isAtTop = false;
          let isAtBottom = false;
          let canTouchScroll = false;
          while (touches && $parent && $parent !== this.$trigger) {
            const overflowY = getTargetValue($parent, "overflow-y");
            if (overflowY !== "hidden" && overflowY !== "visible") {
              const { scrollTop, scrollHeight, clientHeight } = $parent;
              if (scrollHeight > clientHeight) {
                canTouchScroll = true;
                isAtTop = scrollTop <= 3;
                isAtBottom = scrollTop >= scrollHeight - clientHeight - 3;
                break;
              }
            }
            $parent = /** @type {HTMLElement} */
            $parent.parentNode;
          }
          if (canTouchScroll && (!isAtTop && !isAtBottom || isAtTop && movedY < 0 || isAtBottom && movedY > 0)) {
            this.pointer[0] = x4;
            this.pointer[1] = y3;
            this.pointer[2] = x4;
            this.pointer[3] = y3;
            this.pointer[4] = x4;
            this.pointer[5] = y3;
            this.pointer[6] = x4;
            this.pointer[7] = y3;
          } else {
            preventDefault(e3);
            if (!this.triggerStyles) this.triggerStyles = setTargetValues(this.$trigger, { pointerEvents: "none" });
            this.$trigger.addEventListener("touchstart", preventDefault, { passive: false });
            this.$trigger.addEventListener("touchmove", preventDefault, { passive: false });
            this.$trigger.addEventListener("touchend", preventDefault);
            if (!this.disabled[0] && abs(movedX) > 3 || !this.disabled[1] && abs(movedY) > 3) {
              this.updateTicker.resume();
              this.pointer[2] = this.pointer[0];
              this.pointer[3] = this.pointer[1];
              this.pointer[0] = x4;
              this.pointer[1] = y3;
              this.dragged = true;
              this.released = false;
              this.onDrag(this);
            }
          }
        }
        handleUp() {
          if (!this.grabbed) return;
          this.updateTicker.pause();
          if (this.triggerStyles) {
            this.triggerStyles.revert();
            this.triggerStyles = null;
          }
          if (this.bodyStyles) {
            this.bodyStyles.revert();
            this.bodyStyles = null;
          }
          const [disabledX, disabledY] = this.disabled;
          const [px1, py1, px2, py2, px3, py3] = this.pointer;
          const [ct, cr, cb, cl] = this.containerBounds;
          const [sx, sy] = this.snapped;
          const springX = this.releaseXSpring;
          const springY = this.releaseYSpring;
          const releaseEase = this.releaseEase;
          const hasReleaseSpring = this.hasReleaseSpring;
          const overshootCoords = this.overshootCoords;
          const cx = this.x;
          const cy = this.y;
          const pv = this.computeVelocity(px1 - px3, py1 - py3);
          const pa = this.angle = atan2(py1 - py2, px1 - px2);
          const ds = pv * 150;
          const cf = (1 - this.releaseContainerFriction) * this.dragSpeed;
          const nx = cx + cos(pa) * ds;
          const ny = cy + sin(pa) * ds;
          const bx = nx > cr ? cr + (nx - cr) * cf : nx < cl ? cl + (nx - cl) * cf : nx;
          const by = ny > cb ? cb + (ny - cb) * cf : ny < ct ? ct + (ny - ct) * cf : ny;
          const dx = this.destX = clamp(round(snap(bx, this.snapX), 5), cl, cr);
          const dy = this.destY = clamp(round(snap(by, this.snapY), 5), ct, cb);
          const ob = this.isOutOfBounds(this.containerBounds, nx, ny);
          let durationX = 0;
          let durationY = 0;
          let easeX = releaseEase;
          let easeY = releaseEase;
          let longestReleaseDuration = 0;
          overshootCoords.x = cx;
          overshootCoords.y = cy;
          if (!disabledX) {
            const directionX = dx === cr ? cx > cr ? -1 : 1 : cx < cl ? -1 : 1;
            const distanceX = round(cx - dx, 0);
            springX.velocity = disabledY && hasReleaseSpring ? distanceX ? ds * directionX / abs(distanceX) : 0 : pv;
            const { ease, duration, restDuration } = springX;
            durationX = cx === dx ? 0 : hasReleaseSpring ? duration : duration - restDuration * globals.timeScale;
            if (hasReleaseSpring) easeX = ease;
            if (durationX > longestReleaseDuration) longestReleaseDuration = durationX;
          }
          if (!disabledY) {
            const directionY = dy === cb ? cy > cb ? -1 : 1 : cy < ct ? -1 : 1;
            const distanceY = round(cy - dy, 0);
            springY.velocity = disabledX && hasReleaseSpring ? distanceY ? ds * directionY / abs(distanceY) : 0 : pv;
            const { ease, duration, restDuration } = springY;
            durationY = cy === dy ? 0 : hasReleaseSpring ? duration : duration - restDuration * globals.timeScale;
            if (hasReleaseSpring) easeY = ease;
            if (durationY > longestReleaseDuration) longestReleaseDuration = durationY;
          }
          if (!hasReleaseSpring && ob && cf && (durationX || durationY)) {
            const composition = compositionTypes.blend;
            new JSAnimation(overshootCoords, {
              x: { to: bx, duration: durationX * 0.65 },
              y: { to: by, duration: durationY * 0.65 },
              ease: releaseEase,
              composition
            }).init();
            new JSAnimation(overshootCoords, {
              x: { to: dx, duration: durationX },
              y: { to: dy, duration: durationY },
              ease: releaseEase,
              composition
            }).init();
            this.overshootXTicker.stretch(durationX).restart();
            this.overshootYTicker.stretch(durationY).restart();
          } else {
            if (!disabledX) this.animate[this.xProp](dx, durationX, easeX);
            if (!disabledY) this.animate[this.yProp](dy, durationY, easeY);
          }
          this.scrollInView(longestReleaseDuration, this.scrollThreshold, releaseEase);
          let hasSnapped = false;
          if (dx !== sx) {
            this.snapped[0] = dx;
            if (this.snapX) hasSnapped = true;
          }
          if (dy !== sy && this.snapY) {
            this.snapped[1] = dy;
            if (this.snapY) hasSnapped = true;
          }
          if (hasSnapped) this.onSnap(this);
          this.grabbed = false;
          this.dragged = false;
          this.updated = true;
          this.released = true;
          this.onRelease(this);
          this.$trigger.removeEventListener("touchstart", preventDefault);
          this.$trigger.removeEventListener("touchmove", preventDefault);
          this.$trigger.removeEventListener("touchend", preventDefault);
          doc.removeEventListener("touchmove", this);
          doc.removeEventListener("touchend", this);
          doc.removeEventListener("touchcancel", this);
          doc.removeEventListener("mousemove", this);
          doc.removeEventListener("mouseup", this);
          doc.removeEventListener("selectstart", this);
        }
        reset() {
          this.stop();
          this.resizeTicker.pause();
          this.grabbed = false;
          this.dragged = false;
          this.updated = false;
          this.released = false;
          this.canScroll = false;
          this.setX(0, true);
          this.setY(0, true);
          this.coords[0] = 0;
          this.coords[1] = 0;
          this.pointer[0] = 0;
          this.pointer[1] = 0;
          this.pointer[2] = 0;
          this.pointer[3] = 0;
          this.pointer[4] = 0;
          this.pointer[5] = 0;
          this.pointer[6] = 0;
          this.pointer[7] = 0;
          this.velocity = 0;
          this.velocityStack[0] = 0;
          this.velocityStack[1] = 0;
          this.velocityStack[2] = 0;
          this.velocityStackIndex = 0;
          this.angle = 0;
          return this;
        }
        enable() {
          if (!this.enabled) {
            this.enabled = true;
            this.$target.classList.remove("is-disabled");
            this.touchActionStyles = setTargetValues(this.$trigger, {
              touchAction: this.disabled[0] ? "pan-x" : this.disabled[1] ? "pan-y" : "none"
            });
            this.$trigger.addEventListener("touchstart", this, { passive: true });
            this.$trigger.addEventListener("mousedown", this, { passive: true });
            this.$trigger.addEventListener("mouseenter", this);
          }
          return this;
        }
        disable() {
          this.enabled = false;
          this.grabbed = false;
          this.dragged = false;
          this.updated = false;
          this.released = false;
          this.canScroll = false;
          this.touchActionStyles.revert();
          if (this.cursorStyles) {
            this.cursorStyles.revert();
            this.cursorStyles = null;
          }
          if (this.triggerStyles) {
            this.triggerStyles.revert();
            this.triggerStyles = null;
          }
          if (this.bodyStyles) {
            this.bodyStyles.revert();
            this.bodyStyles = null;
          }
          if (this.targetStyles) {
            this.targetStyles.revert();
            this.targetStyles = null;
          }
          this.$target.classList.add("is-disabled");
          this.$trigger.removeEventListener("touchstart", this);
          this.$trigger.removeEventListener("mousedown", this);
          this.$trigger.removeEventListener("mouseenter", this);
          doc.removeEventListener("touchmove", this);
          doc.removeEventListener("touchend", this);
          doc.removeEventListener("touchcancel", this);
          doc.removeEventListener("mousemove", this);
          doc.removeEventListener("mouseup", this);
          doc.removeEventListener("selectstart", this);
          return this;
        }
        revert() {
          this.reset();
          this.disable();
          this.$target.classList.remove("is-disabled");
          this.updateTicker.revert();
          this.overshootXTicker.revert();
          this.overshootYTicker.revert();
          this.resizeTicker.revert();
          this.animate.revert();
          this.resizeObserver.disconnect();
          return this;
        }
        /**
         * @param {Event} e
         */
        handleEvent(e3) {
          switch (e3.type) {
            case "mousedown":
              this.handleDown(
                /** @type {MouseEvent} */
                e3
              );
              break;
            case "touchstart":
              this.handleDown(
                /** @type {TouchEvent} */
                e3
              );
              break;
            case "mousemove":
              this.handleMove(
                /** @type {MouseEvent} */
                e3
              );
              break;
            case "touchmove":
              this.handleMove(
                /** @type {TouchEvent} */
                e3
              );
              break;
            case "mouseup":
              this.handleUp();
              break;
            case "touchend":
              this.handleUp();
              break;
            case "touchcancel":
              this.handleUp();
              break;
            case "mouseenter":
              this.handleHover();
              break;
            case "selectstart":
              preventDefault(e3);
              break;
          }
        }
      };
      createDraggable = /* @__PURE__ */ __name((target, parameters) => new Draggable(target, parameters), "createDraggable");
      Scope = class {
        static {
          __name(this, "Scope");
        }
        /** @param {ScopeParams} [parameters] */
        constructor(parameters = {}) {
          if (scope2.current) scope2.current.register(this);
          const rootParam = parameters.root;
          let root = doc;
          if (rootParam) {
            root = /** @type {ReactRef} */
            rootParam.current || /** @type {AngularRef} */
            rootParam.nativeElement || parseTargets(
              /** @type {DOMTargetSelector} */
              rootParam
            )[0] || doc;
          }
          const scopeDefaults = parameters.defaults;
          const globalDefault = globals.defaults;
          const mediaQueries = parameters.mediaQueries;
          this.defaults = scopeDefaults ? mergeObjects(scopeDefaults, globalDefault) : globalDefault;
          this.root = root;
          this.constructors = [];
          this.revertConstructors = [];
          this.revertibles = [];
          this.constructorsOnce = [];
          this.revertConstructorsOnce = [];
          this.revertiblesOnce = [];
          this.once = false;
          this.onceIndex = 0;
          this.methods = {};
          this.matches = {};
          this.mediaQueryLists = {};
          this.data = {};
          if (mediaQueries) {
            for (let mq in mediaQueries) {
              const _mq = win.matchMedia(mediaQueries[mq]);
              this.mediaQueryLists[mq] = _mq;
              _mq.addEventListener("change", this);
            }
          }
        }
        /**
         * @param {Revertible} revertible
         */
        register(revertible) {
          const store = this.once ? this.revertiblesOnce : this.revertibles;
          store.push(revertible);
        }
        /**
         * @template T
         * @param {ScopedCallback<T>} cb
         * @return {T}
         */
        execute(cb) {
          let activeScope = scope2.current;
          let activeRoot = scope2.root;
          let activeDefaults = globals.defaults;
          scope2.current = this;
          scope2.root = this.root;
          globals.defaults = this.defaults;
          const mqs = this.mediaQueryLists;
          for (let mq in mqs) this.matches[mq] = mqs[mq].matches;
          const returned = cb(this);
          scope2.current = activeScope;
          scope2.root = activeRoot;
          globals.defaults = activeDefaults;
          return returned;
        }
        /**
         * @return {this}
         */
        refresh() {
          this.onceIndex = 0;
          this.execute(() => {
            let i3 = this.revertibles.length;
            let y3 = this.revertConstructors.length;
            while (i3--) this.revertibles[i3].revert();
            while (y3--) this.revertConstructors[y3](this);
            this.revertibles.length = 0;
            this.revertConstructors.length = 0;
            this.constructors.forEach((constructor) => {
              const revertConstructor = constructor(this);
              if (isFnc(revertConstructor)) {
                this.revertConstructors.push(revertConstructor);
              }
            });
          });
          return this;
        }
        /**
         * @overload
         * @param {String} a1
         * @param {ScopeMethod} a2
         * @return {this}
         *
         * @overload
         * @param {ScopeConstructorCallback} a1
         * @return {this}
         *
         * @param {String|ScopeConstructorCallback} a1
         * @param {ScopeMethod} [a2]
         */
        add(a1, a22) {
          this.once = false;
          if (isFnc(a1)) {
            const constructor = (
              /** @type {ScopeConstructorCallback} */
              a1
            );
            this.constructors.push(constructor);
            this.execute(() => {
              const revertConstructor = constructor(this);
              if (isFnc(revertConstructor)) {
                this.revertConstructors.push(revertConstructor);
              }
            });
          } else {
            this.methods[
              /** @type {String} */
              a1
            ] = (...args) => this.execute(() => a22(...args));
          }
          return this;
        }
        /**
         * @param {ScopeConstructorCallback} scopeConstructorCallback
         * @return {this}
         */
        addOnce(scopeConstructorCallback) {
          this.once = true;
          if (isFnc(scopeConstructorCallback)) {
            const currentIndex = this.onceIndex++;
            const tracked = this.constructorsOnce[currentIndex];
            if (tracked) return this;
            const constructor = (
              /** @type {ScopeConstructorCallback} */
              scopeConstructorCallback
            );
            this.constructorsOnce[currentIndex] = constructor;
            this.execute(() => {
              const revertConstructor = constructor(this);
              if (isFnc(revertConstructor)) {
                this.revertConstructorsOnce.push(revertConstructor);
              }
            });
          }
          return this;
        }
        /**
         * @param  {(scope: this) => Tickable} cb
         * @return {Tickable}
         */
        keepTime(cb) {
          this.once = true;
          const currentIndex = this.onceIndex++;
          const tracked = (
            /** @type {(scope: this) => Tickable} */
            this.constructorsOnce[currentIndex]
          );
          if (isFnc(tracked)) return tracked(this);
          const constructor = (
            /** @type {(scope: this) => Tickable} */
            createRefreshable(cb)
          );
          this.constructorsOnce[currentIndex] = constructor;
          let trackedTickable;
          this.execute(() => {
            trackedTickable = constructor(this);
          });
          return trackedTickable;
        }
        /**
         * @param {Event} e
         */
        handleEvent(e3) {
          switch (e3.type) {
            case "change":
              this.refresh();
              break;
          }
        }
        revert() {
          const revertibles = this.revertibles;
          const revertConstructors = this.revertConstructors;
          const revertiblesOnce = this.revertiblesOnce;
          const revertConstructorsOnce = this.revertConstructorsOnce;
          const mqs = this.mediaQueryLists;
          let i3 = revertibles.length;
          let j4 = revertConstructors.length;
          let k4 = revertiblesOnce.length;
          let l3 = revertConstructorsOnce.length;
          while (i3--) revertibles[i3].revert();
          while (j4--) revertConstructors[j4](this);
          while (k4--) revertiblesOnce[k4].revert();
          while (l3--) revertConstructorsOnce[l3](this);
          for (let mq in mqs) mqs[mq].removeEventListener("change", this);
          revertibles.length = 0;
          revertConstructors.length = 0;
          this.constructors.length = 0;
          revertiblesOnce.length = 0;
          revertConstructorsOnce.length = 0;
          this.constructorsOnce.length = 0;
          this.onceIndex = 0;
          this.matches = {};
          this.methods = {};
          this.mediaQueryLists = {};
          this.data = {};
        }
      };
      createScope = /* @__PURE__ */ __name((params) => new Scope(params), "createScope");
      segmenter = !isUnd(Intl) && Intl.Segmenter;
    }
  });

  // bips/Toast/Toast.js
  var html21, icon, Toast_default;
  var init_Toast = __esm({
    "bips/Toast/Toast.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_lucide_preact();
      init_anime_esm();
      html21 = htm_module_default.bind(_);
      icon = {
        "lock": Lock,
        "primary": Megaphone,
        "warning": TriangleAlert,
        "success": PartyPopper,
        "null": CircleOff
      };
      Toast_default = Toast = /* @__PURE__ */ __name(({ id, message, options: options2 = {}, onDismiss }) => {
        const root = A2(null);
        const scope3 = A2(null);
        const dismiss = /* @__PURE__ */ __name(() => {
          scope3.current.methods.bounceOut();
        }, "dismiss");
        y2(() => {
          let word_count = message.split(" ").length;
          let default_duration = 3e3;
          if (word_count >= 5) {
            default_duration = 3e3 + (word_count - 5) * 400;
          }
          let duration = options2.duration || default_duration;
          scope3.current = createScope({ root }).add((self2) => {
            animate(root.current, {
              opacity: [0, 1],
              translateY: [20, 0],
              duration: 500,
              easing: "out(2)",
              delay: 200
            });
            createDraggable(root.current, {
              container: [0, 0, 0, 0],
              releaseEase: createSpring({ stiffness: 200 })
            });
            animate(".bip-toast-progress-bar", {
              width: ["0%", "90%"],
              duration,
              easing: "linear"
            });
            self2.add("bounceOut", () => {
              animate(root.current, {
                opacity: [1, 0],
                translateY: [0, -20],
                duration: 500,
                easing: "out(2)",
                onComplete: /* @__PURE__ */ __name(() => {
                  onDismiss(id);
                }, "onComplete")
              });
            });
          });
          const timer = setTimeout(() => {
            dismiss(id);
          }, duration);
          return () => {
            scope3.current.revert();
            clearTimeout(timer);
          };
        }, []);
        let Icon2 = null;
        if (options2.icon && icon[options2.icon]) {
          Icon2 = icon[options2.icon];
        } else if (options2.variation && icon[options2.variation]) {
          Icon2 = icon[options2.variation];
        }
        let variationClass = options2.variation ? ` bip-toast-${options2.variation}` : "bip-toast-default";
        return html21`
        <div ref=${root} class="bip-toast ${variationClass}" role="alert">
            <p class="bip-toast-icon">
                ${Icon2 ? html21`<${Icon2} />` : null}
            </p>
            <p class="bip-toast-message">
                ${message}
            </p>
            <button class="bip-toast-dismiss" onClick=${dismiss}>
                <${X2} />
            </button>

            <div class="bip-toast-progress-bar"></div>
        </div>
    `;
      }, "Toast");
    }
  });

  // pages/Community/CommunityHomePageLayout.js
  var html22, CommunityHomePageLayout, CommunityHomePageLayout_default;
  var init_CommunityHomePageLayout = __esm({
    "pages/Community/CommunityHomePageLayout.js"() {
      init_preact_module();
      init_hooks_module();
      init_src();
      init_htm_module();
      init_lucide_preact();
      init_Loading();
      init_ToastContext();
      init_Toast();
      html22 = htm_module_default.bind(_);
      CommunityHomePageLayout = /* @__PURE__ */ __name(({ slug, loading, pageName, fullyTransparent = false, children }) => {
        let { url, path, query, route } = useLocation();
        let [loggedIn, setLoggedIn] = d2(false);
        let [session, setSession] = d2(null);
        let [admin, setAdmin] = d2(false);
        let [unseenMessageCount, setMessageCount] = d2(0);
        let { getToasts, dismissToast } = useToast();
        let toasts = getToasts();
        let extraClass = fullyTransparent ? "" : " basic-glossy-panel";
        y2(async () => {
          try {
            let session2 = await window.Data.session.getSession({ slug });
            if (!session2) {
              if (url.includes(`/community/${slug}`)) {
                setLoggedIn(false);
                return;
              } else {
                route(`/community/${slug}`);
              }
            } else {
              console.dir(session2);
              document.title = `${session2.community_name} ${pageName ? `| ${pageName}` : ""}`;
              setSession(session2);
              setLoggedIn(true);
              if (session2.is_admin) {
                setAdmin(true);
              }
            }
            let count = await window.Data.message.getUnseenMessageCount({ slug });
            setMessageCount(count);
            await window.Data.live.createConnection({ slug });
            window.Data.live.on("MessagesChanged", async () => {
              let count2 = await window.Data.message.getUnseenMessageCount({ slug });
              setMessageCount(count2);
            });
          } catch (e3) {
            if (e3?.message.includes("not verified")) {
              route(`/community/${slug}/verify`);
              return;
            }
            console.error("Error fetching sossion:", e3);
            if (url !== `/community/${slug}`) {
              console.warn("routing to community page due to session error");
              route(`/community/${slug}`);
            }
          }
        }, [pageName]);
        let communityName = session?.community_name || "loading...";
        let userName = session?.user_name || "loading...";
        let loadingOrChildren = loading ? html22`<${Loading_default} center margin />` : children;
        return html22`
    <div class="basic-page-layout">
            <nav class="top-nav no-print">
                <a href="/community/${slug}" title=${communityName}>
                    <${House} />
                </a>
                <a href="/community/${slug}/messages">
                    <${Mails} />
                    ${unseenMessageCount > 0 ? html22`<span class="message-count-badge">${unseenMessageCount}</span>` : null}
                </a>
                <a href="/community/${slug}/users" title="Users">
                    <${UserSearch} />
                </a>
                <a href="/community/${slug}/profile" title=${userName}>
                    <${CircleUser} />
                </a>
                ${admin ? html22`
                <a href="/community/${slug}/admin" title="Admin" style=${admin ? "" : "display: none;"}>
                    <${ServerCog} />
                </a>
                ` : null}
            </nav>

            <div>
                <div class="content ${extraClass}">
                    <div class="content-inner">
                        ${loadingOrChildren}
                    </div>
                </div>
                <div class="bip-toast-container">
                    ${toasts.map((toast) => html22`<${Toast_default} key=${toast.id} message=${toast.message} options=${toast.options} onDismiss=${() => dismissToast(toast.id)} />`)}
                </div>
            </div>
    </div>
    `;
      }, "CommunityHomePageLayout");
      CommunityHomePageLayout_default = CommunityHomePageLayout;
    }
  });

  // pages/CommunityPublicSection.js
  var html23, CommunityPublicSection, CommunityPublicSection_default;
  var init_CommunityPublicSection = __esm({
    "pages/CommunityPublicSection.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_Button();
      init_CommunityWidget();
      html23 = htm_module_default.bind(_);
      CommunityPublicSection = /* @__PURE__ */ __name(({ slug }) => {
        let { route } = useLocation();
        y2(() => {
          document.title = slug;
        }, []);
        return html23`
    <div class="community-public-blob">

        <${CommunityWidget_default} slug=${slug} />

        <${Button_default} onClick=${() => route(`/community/${slug}/login`)}>Login<//>

    </div>
    `;
      }, "CommunityPublicSection");
      CommunityPublicSection_default = CommunityPublicSection;
    }
  });

  // pages/Community/CommunityHomeSection.js
  var html24, CommunityHomeSection, CommunityHomeSection_default;
  var init_CommunityHomeSection = __esm({
    "pages/Community/CommunityHomeSection.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_CommunityWidget();
      init_Button();
      html24 = htm_module_default.bind(_);
      CommunityHomeSection = /* @__PURE__ */ __name(({ slug, session, community_name }) => {
        let [error, setError] = d2(null);
        let { url, path, query, route } = useLocation();
        const trafficForm = /* @__PURE__ */ __name((e3) => {
          e3.preventDefault();
          route(`/community/${slug}/mountain_view/traffic_control_form`);
        }, "trafficForm");
        return html24`
    <${CommunityWidget_default} slug=${slug} />
    <hr/>
    <div class="community-public-blob">
        <p> Hi, <strong>${session.user_name}</strong>! </p>

    </div>
    `;
      }, "CommunityHomeSection");
      CommunityHomeSection_default = CommunityHomeSection;
    }
  });

  // pages/CommunityPage.js
  var CommunityPage_exports = {};
  __export(CommunityPage_exports, {
    default: () => CommunityPage_default
  });
  var html25, CommunityPage, CommunityPage_default;
  var init_CommunityPage = __esm({
    "pages/CommunityPage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_BasicPageLayout();
      init_CommunityHomePageLayout();
      init_CommunityPublicSection();
      init_CommunityHomeSection();
      html25 = htm_module_default.bind(_);
      CommunityPage = /* @__PURE__ */ __name(({ slug }) => {
        let [error, setError] = d2(null);
        let [loading, setLoading] = d2(true);
        let [session, setSession] = d2(null);
        let [community, setCommunity] = d2(null);
        let { url, path, query, route } = useLocation();
        y2(async () => {
          let session2, community2;
          try {
            session2 = await window.Data.session.getSession({ slug });
            setSession(session2);
          } catch (e3) {
            console.error("Error getting session:", e3);
          }
          try {
            community2 = await window.Data.community.getCommunity({ slug });
            setCommunity(community2);
          } catch (e3) {
            console.error("Error getting community:", e3);
            setError(e3.message);
          }
          if (community2 && session2) {
            await window.Data.community.addActiveCommunity({ community_slug: slug });
          }
          setLoading(false);
        }, []);
        if (session) {
          return html25`
        <${CommunityHomePageLayout_default} loading=${loading} slug=${slug} session=${session}>
            <${CommunityHomeSection_default} slug=${slug} session=${session} community_name=${community ? community.community_name : "Community"} />
        <//>
        `;
        } else {
          return html25`
        <${BasicPageLayout_default} loading=${loading} title="${community ? community.community_name : "Community"}">
            <${CommunityPublicSection_default} slug=${slug} community_name=${community ? community.community_name : "Community"} />
        <//>
        `;
        }
      }, "CommunityPage");
      CommunityPage_default = CommunityPage;
    }
  });

  // pages/CommunityVerify/CommunitySMSVerifyForm.js
  var html26, CommunitySMSVerifyForm, CommunitySMSVerifyForm_default;
  var init_CommunitySMSVerifyForm = __esm({
    "pages/CommunityVerify/CommunitySMSVerifyForm.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_Button();
      init_Input();
      init_Alert();
      html26 = htm_module_default.bind(_);
      CommunitySMSVerifyForm = /* @__PURE__ */ __name(({ slug, session, onComplete }) => {
        let [error, setError] = d2(null);
        let { url, path, query, route } = useLocation();
        let [numFailures, setNumFailures] = d2(-1);
        if (!onComplete || typeof onComplete != "function") {
          onComplete = /* @__PURE__ */ __name(() => {
          }, "onComplete");
        }
        y2(async () => {
          try {
            await window.Data.verify.sendSmsVerificationCode({ slug });
          } catch (e3) {
            setError(e3.message);
          }
        }, []);
        const retry = /* @__PURE__ */ __name(async () => {
          try {
            await window.Data.verify.sendSmsVerificationCode({ slug });
          } catch (e3) {
            setError(e3.message);
          }
        }, "retry");
        const formSubmit = /* @__PURE__ */ __name(async (e3) => {
          e3.preventDefault();
          let form = e3.target;
          let formData = new FormData(form);
          let data = {};
          for (let key2 of formData.keys()) {
            data[key2] = formData.get(key2);
          }
          console.dir(data["code"]);
          if (!data["code"]) {
            setError("Please enter the verification code.");
            return;
          }
          if (data["code"].length != 6) {
            setError("Please enter a 6-digit verification code.");
            return;
          }
          try {
            await Data.verify.verifySmsVerificationCode({ slug, user_id: session?.user_id, code: data["code"] });
            await onComplete();
          } catch (e4) {
            console.error(e4);
            setNumFailures(numFailures + 1);
            setError(e4.message);
            return;
          }
        }, "formSubmit");
        let still = "";
        if (numFailures > 0) {
          still = "still ".repeat(numFailures);
        }
        return html26`
    <div class="community-sms-verify-form">
        <h3>SMS Verification</h3>

        <p> A verification code has been sent to your <strong>phone number</strong>. Please enter the code below to verify your account. </p>
        <form onSubmit=${formSubmit}>
            <${Input_default} name="code" label="Verification Code" type="vercode" required />
            <br />
            <${Alert_default} variant="error" message=${error} />
            <${Button_default} type="submit" variant="primary">Verify<//>
            <${Button_default} onClick=${retry}>Send Another Code<//>
        </form>
    </div>
    `;
      }, "CommunitySMSVerifyForm");
      CommunitySMSVerifyForm_default = CommunitySMSVerifyForm;
    }
  });

  // pages/CommunityVerify/CommunityEmailVerifyForm.js
  var html27, CommunityEmailVerifyForm, CommunityEmailVerifyForm_default;
  var init_CommunityEmailVerifyForm = __esm({
    "pages/CommunityVerify/CommunityEmailVerifyForm.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_Button();
      init_Input();
      init_Alert();
      html27 = htm_module_default.bind(_);
      CommunityEmailVerifyForm = /* @__PURE__ */ __name(({ slug, session, onComplete }) => {
        let [error, setError] = d2(null);
        let [retryButtonLoading, setRetryButtonLoading] = d2(false);
        let [hideRetryButton, setHideRetryButton] = d2(false);
        let [verifyButtonLoading, setVerifyButtonLoading] = d2(false);
        let { url, path, query, route } = useLocation();
        let [numFailures, setNumFailures] = d2(-1);
        if (!onComplete || typeof onComplete != "function") {
          onComplete = /* @__PURE__ */ __name(() => {
          }, "onComplete");
        }
        y2(async () => {
          try {
            await window.Data.verify.sendEmailVerificationCode({ slug });
          } catch (e3) {
            setError(e3.message);
          }
        }, []);
        const retry = /* @__PURE__ */ __name(async (e3) => {
          e3.preventDefault();
          setRetryButtonLoading(true);
          try {
            await window.Data.verify.sendEmailVerificationCode({ slug });
            setError("My email provider's reputation is terrible ever since I did all of those crimes, so you might need to check for the email in your spam folder.");
            setHideRetryButton(true);
          } catch (e4) {
            setError(e4.message);
          } finally {
            setRetryButtonLoading(false);
          }
        }, "retry");
        const formSubmit = /* @__PURE__ */ __name(async (e3) => {
          setVerifyButtonLoading(true);
          e3.preventDefault();
          let form = e3.target;
          let formData = new FormData(form);
          let data = {};
          for (let key2 of formData.keys()) {
            data[key2] = formData.get(key2);
          }
          console.dir(data["code"]);
          if (!data["code"]) {
            setError("Please enter the verification code.");
            return;
          }
          if (data["code"].length != 6) {
            setError("Please enter a 6-digit verification code.");
            return;
          }
          try {
            await Data.verify.verifyEmailVerificationCode({ slug, user_id: session?.user_id, code: data["code"] });
            await onComplete();
          } catch (e4) {
            console.error(e4);
            setNumFailures(numFailures + 1);
            setError(e4.message);
            return;
          } finally {
            setVerifyButtonLoading(false);
          }
        }, "formSubmit");
        let still = "";
        if (numFailures > 0) {
          still = "still ".repeat(numFailures);
        }
        return html27`
    <div class="community-email-verify-form">
        <h3>Email Verification</h3>

        <p> A verification code has been sent to your <strong>email</strong>. Please enter the code below to verify your account. </p>
        <form onSubmit=${formSubmit}>
            <${Input_default} name="code" label="Verification Code" type="vercode" required />
            <br />
            <${Alert_default} variant="error" message=${error} />
            <${Button_default} type="submit" variant="primary" loading=${verifyButtonLoading}>Verify<//>
            ${!hideRetryButton ? html27`<${Button_default} onClick=${retry} loading=${retryButtonLoading}>Send Another Code<//>` : null}
        </form>
    </div>
    `;
      }, "CommunityEmailVerifyForm");
      CommunityEmailVerifyForm_default = CommunityEmailVerifyForm;
    }
  });

  // pages/CommunityVerifyPage.js
  var CommunityVerifyPage_exports = {};
  __export(CommunityVerifyPage_exports, {
    default: () => CommunityVerifyPage_default
  });
  var html28, CommunityVerifyPage, CommunityVerifyPage_default;
  var init_CommunityVerifyPage = __esm({
    "pages/CommunityVerifyPage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_BasicPageLayout();
      init_CommunitySMSVerifyForm();
      init_CommunityEmailVerifyForm();
      html28 = htm_module_default.bind(_);
      CommunityVerifyPage = /* @__PURE__ */ __name(({ slug }) => {
        let [session, setSession] = d2(null);
        let [phone_needs_verified, setPhoneNeedsVerified] = d2(false);
        let [email_needs_verified, setEmailNeedsVerified] = d2(false);
        let { url, path, query, route } = useLocation();
        const whatVerificationIsNeeded = /* @__PURE__ */ __name(async () => {
          try {
            let session2 = await window.Data.session.getSession({ slug, reload: true });
            if (!session2) {
              route("/");
            }
            console.dir(session2);
            setSession(session2);
            if (session2.user_tags.includes("has_phone") && !session2.user_tags.includes("phone_verified")) {
              console.log("phone needs verified");
              setPhoneNeedsVerified(true);
            } else {
              setPhoneNeedsVerified(false);
            }
            if (session2.user_tags.includes("has_email") && !session2.user_tags.includes("email_verified")) {
              console.log("email needs verified");
              setEmailNeedsVerified(true);
            } else {
              setEmailNeedsVerified(false);
            }
          } catch (e3) {
            console.error(e3);
            route("/");
          }
        }, "whatVerificationIsNeeded");
        y2(async () => {
          await whatVerificationIsNeeded();
        }, []);
        const refresh = /* @__PURE__ */ __name(async () => {
          await whatVerificationIsNeeded();
        }, "refresh");
        if (!session) {
          return html28`<${BasicPageLayout_default} title="Loading..."></${BasicPageLayout_default}>`;
        }
        let content;
        if (phone_needs_verified) {
          content = html28`<${CommunitySMSVerifyForm_default} slug=${slug} session=${session} onComplete=${refresh} />`;
        } else if (email_needs_verified) {
          content = html28`<${CommunityEmailVerifyForm_default} slug=${slug} session=${session} onComplete=${refresh} />`;
        } else {
          content = html28`<div>
            <h3>Verification Complete</h3>
            <p> Your account has been verified. </p>

            <a href="/community/${slug}">Finally!</a>
        </div>`;
        }
        return html28`
    <${BasicPageLayout_default} title=${session.community_name}>
        ${content}
    </div>
    `;
      }, "CommunityVerifyPage");
      CommunityVerifyPage_default = CommunityVerifyPage;
    }
  });

  // pages/CommunityVerify/CommunityVerifyLinkPage.js
  var CommunityVerifyLinkPage_exports = {};
  __export(CommunityVerifyLinkPage_exports, {
    default: () => CommunityVerifyLinkPage_default
  });
  var html29, CommunityVerifyLinkPage, CommunityVerifyLinkPage_default;
  var init_CommunityVerifyLinkPage = __esm({
    "pages/CommunityVerify/CommunityVerifyLinkPage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_BasicPageLayout();
      init_Alert();
      html29 = htm_module_default.bind(_);
      CommunityVerifyLinkPage = /* @__PURE__ */ __name(({ slug }) => {
        let [error, setError] = d2(null);
        let { url, path, query, route } = useLocation();
        console.dir(slug);
        console.dir(query);
        y2(async () => {
          let user_id = query["user_id"];
          let code = query["code"];
          if (!user_id || !code) {
            setError("Invalid verification link.");
            return;
          }
          try {
            await Data.verify.verifyEmailVerificationCode({ slug, user_id, code });
          } catch (err) {
            if (err.message.includes("Failed to deserialize")) {
              setError("Something about that verification link was invalid!");
            } else {
              setError(err.message);
            }
            return;
          }
          route(`/community/${slug}/verify`);
        }, []);
        return html29`
    <${BasicPageLayout_default} title="Verify Your Email">

        <${Alert_default} variant="error" message=${error} />
    </div>
    `;
      }, "CommunityVerifyLinkPage");
      CommunityVerifyLinkPage_default = CommunityVerifyLinkPage;
    }
  });

  // pages/LoginPage.js
  var LoginPage_exports = {};
  __export(LoginPage_exports, {
    default: () => LoginPage_default
  });
  var html30, LoginPage, LoginPage_default;
  var init_LoginPage = __esm({
    "pages/LoginPage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_Input();
      init_Button();
      init_BasicPageLayout();
      init_Alert();
      html30 = htm_module_default.bind(_);
      LoginPage = /* @__PURE__ */ __name(({ slug }) => {
        let [error, setError] = d2(null);
        let { url, path, query, route } = useLocation();
        let [buttonLoading, setButtonLoading] = d2(false);
        let [forgotPassword, setForgotPassword] = d2(false);
        y2(async () => {
          try {
            let session = await window.Data.session.getSession({ slug });
            if (session) {
              console.warn("already logged in!");
              route(`/community/${slug}`);
            }
          } catch (e3) {
          }
        }, []);
        const formSubmit = /* @__PURE__ */ __name(async (e3) => {
          setButtonLoading(true);
          e3.preventDefault();
          let form2 = e3.target.closest("form");
          let formData = new FormData(form2);
          setError(null);
          let data = {};
          for (let key2 of formData.keys()) {
            data[key2] = formData.get(key2);
          }
          let login = {
            password: data["password"],
            token: data["token"]
          };
          if (data["email_or_phone"]) {
            let email_or_phone = data["email_or_phone"];
            if (email_or_phone.includes("@")) {
              login.email = email_or_phone;
            } else {
              login.phone_number = email_or_phone;
            }
          }
          try {
            if (login.token) {
              if (!query.user_id) {
                throw new Error("No user_id provided");
              }
              await window.Data.session.loginTokenComplete({ slug, user_id: query.user_id, ...login });
              route(`/community/${slug}`);
            } else if (login.password) {
              let resp = await window.Data.session.login({ slug, ...login });
              if (!resp) {
                throw new Error("Authentication failed.");
              }
              if (resp.error) {
                throw new Error(resp.error);
              }
              route(`/community/${slug}`);
            } else {
              let resp = await window.Data.session.loginToken({ slug, ...login });
              if (resp.error) {
                throw new Error(resp.error);
              }
              let userId = resp.user_id ?? resp.userId;
              if (login.email) {
                route(`/community/${slug}/login?type=token-email&user_id=${userId}`);
              } else {
                route(`/community/${slug}/login?type=token-phone&user_id=${userId}`);
              }
            }
          } catch (e4) {
            setError(e4.message);
          } finally {
            setButtonLoading(false);
          }
        }, "formSubmit");
        let type = query.type ?? "default";
        let form = null;
        switch (type) {
          case "token-email": {
            form = html30`
            <p>
                A token has been sent to your email! Please enter it below to login.
            </p>
            <form onSubmit=${formSubmit}>
                <${Input_default}
                    id="token"
                    name="token"
                    type="text"
                    label="Token"
                    minlength="1"
                    hideHelpText
                    required/>
                <br/>
                <${Button_default} loading=${buttonLoading} type="submit">Login<//>
            </form>`;
            break;
          }
          case "token-phone": {
            form = html30`
            <p>
                A token has been sent to your phone! Please enter it below to login.
            </p>
            <form onSubmit=${formSubmit}>
                <${Input_default}
                    id="token"
                    name="token"
                    type="text"
                    label="Token"
                    minlength="1"
                    hideHelpText
                    required/>
                <br/>
                <${Button_default} loading=${buttonLoading} type="submit" variant="primary">Login<//>
            </form>`;
            break;
          }
          case "default": {
            form = html30`
            <form onSubmit=${formSubmit}>
                <${Input_default}
                    id="email_or_phone"
                    name="email_or_phone"
                    type="email_or_tel"
                    label="Email or Phone Number"
                    placeholder="beefs@cheese.corn or 555-555-5555"
                    minlength="1"
                    hideHelpText
                    required/>
                <br/>
                ${forgotPassword ? html30`<p>No worries! Just enter your email or phone number above and we'll send you a login token.</p>` : html30`<${Input_default}
                        type="password"
                        id="password"
                        name="password"
                        label="Password"
                        minlength="8"
                        hideHelpText
                        required/>
                    <br/>`}
                <${Button_default} loading=${buttonLoading} type="submit" variant="primary">Login<//>
                ${forgotPassword ? null : html30`
                    <${Button_default} loading=${buttonLoading} onClick=${(e3) => {
              e3.preventDefault();
              setForgotPassword(true);
            }} variant="secondary">Forgot Password?<//>
                `}
            </form>`;
            break;
          }
          default: {
            break;
          }
        }
        return html30`
    <${BasicPageLayout_default} title="Login">
        ${form}
        <br/>
        <br/>
        <${Alert_default} message=${error} />
    </div>
    `;
      }, "LoginPage");
      LoginPage_default = LoginPage;
    }
  });

  // pages/LogoutPage.js
  var LogoutPage_exports = {};
  __export(LogoutPage_exports, {
    default: () => LogoutPage_default
  });
  var html31, LogoutPage, LogoutPage_default;
  var init_LogoutPage = __esm({
    "pages/LogoutPage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_Button();
      init_BasicPageLayout();
      init_Alert();
      html31 = htm_module_default.bind(_);
      LogoutPage = /* @__PURE__ */ __name(({ slug }) => {
        let [error, setError] = d2(null);
        let { url, path, query, route } = useLocation();
        y2(async () => {
          try {
            await window.Data.session.logout({ slug });
            route(`/community/${slug}`);
          } catch (e3) {
            console.warn("this happened");
            setError(`${e3.message} - but that's probably fine, it just means you're already logged out.`);
          }
        }, []);
        return html31`
    <${BasicPageLayout_default} title="Logout">
        <${Button_default} onClick=${() => route(`/community/${slug}`)}>Home<//>
        <br/>
        <br/>
        <${Alert_default} error=${error} />

    </div>
    `;
      }, "LogoutPage");
      LogoutPage_default = LogoutPage;
    }
  });

  // sha256.js
  async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b2) => b2.toString(16).padStart(2, "0")).join("");
    return hashHex;
  }
  var init_sha256 = __esm({
    "sha256.js"() {
      __name(sha256, "sha256");
    }
  });

  // bips/Gravatar.js
  var html32, Gravatar, Gravatar_default;
  var init_Gravatar = __esm({
    "bips/Gravatar.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_sha256();
      html32 = htm_module_default.bind(_);
      Gravatar = /* @__PURE__ */ __name(({ hashable, overrideSha, defaultType = "retro", title }) => {
        let [sha, setSha] = d2(overrideSha);
        y2(() => {
          const computeSha = /* @__PURE__ */ __name(async () => {
            if (overrideSha) {
              return;
            }
            if (!hashable) {
              return;
            }
            let sha256_ip = await sha256(hashable);
            setSha(sha256_ip);
          }, "computeSha");
          computeSha();
        }, [hashable]);
        return html32`
        ${sha && html32`<img class="gravatar" src="https://gravatar.com/avatar/${sha}?d=${defaultType}" alt="${title}" title=${title} />`}
    `;
      }, "Gravatar");
      Gravatar_default = Gravatar;
    }
  });

  // widgets/User/UserSpan.js
  var html33, UserSpan, UserSpan_default;
  var init_UserSpan = __esm({
    "widgets/User/UserSpan.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_Gravatar();
      html33 = htm_module_default.bind(_);
      UserSpan = /* @__PURE__ */ __name(({ slug, userId, isMe }) => {
        const [user, setUser] = d2(null);
        const [loading, setLoading] = d2(true);
        y2(() => {
          const fetchUser = /* @__PURE__ */ __name(async () => {
            try {
              let userData = await window.Data.user.getUser({ slug, userId });
              setUser(userData);
            } catch (e3) {
              console.error("Error fetching user:", e3.message);
            } finally {
              setLoading(false);
            }
          }, "fetchUser");
          fetchUser();
        }, [userId]);
        let gravatar = null;
        if (user) {
          gravatar = html33`<${Gravatar_default} hashable=${user.id} overrideSha=${user.email} defaultType="wavatar" title=${user.name} />`;
          if (isMe) {
            gravatar = html33`<${Gravatar_default} hashable=${user.email} defaultType="wavatar" title=${user.name} />`;
          }
        }
        if (loading) {
          return html33`<span>Loading...</span>`;
        }
        if (!user) {
          return html33`<span>${userId}</span>`;
        }
        return html33`
    <span class="user-span">
        <span class="user-gravatar">
            ${gravatar}
        </span>
        <a href="/community/${slug}/users/${user.slug}">${user.name}</a>
    </span>`;
      }, "UserSpan");
      UserSpan_default = UserSpan;
    }
  });

  // pages/Community/InviteCodePage.js
  var InviteCodePage_exports = {};
  __export(InviteCodePage_exports, {
    default: () => InviteCodePage_default
  });
  var html34, useTypeToLabel, useTypeToIcon, InviteCode2, InviteCodeSection, InviteCodePage, InviteCodePage_default;
  var init_InviteCodePage = __esm({
    "pages/Community/InviteCodePage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_lucide_preact();
      init_Button();
      init_CommunityHomePageLayout();
      init_Alert();
      init_ButtonFrame();
      init_Flexstack();
      init_UserSpan();
      init_ToastContext();
      html34 = htm_module_default.bind(_);
      useTypeToLabel = {
        once: "Single Use",
        Once: "Single Use",
        unlimited: "Unlimited",
        Unlimited: "Unlimited"
      };
      useTypeToIcon = {
        once: Box,
        Once: Box,
        unlimited: Boxes,
        Unlimited: Boxes
      };
      InviteCode2 = /* @__PURE__ */ __name(({ slug, code, session, onDelete }) => {
        const [loading, setLoading] = d2(false);
        let linkTarget = `/community/${slug}/invite/${code.invite_code}`;
        let fullLinkTarget = `${window.location.origin}${linkTarget}`;
        let label = useTypeToLabel[code.use_type] || `${code.use_type}?`;
        let UseTypeIcon = useTypeToIcon[code.use_type] || Box;
        let createdBy = code.created_by;
        let createdByMe = session?.user_id === createdBy;
        const deleteInviteCode = /* @__PURE__ */ __name(async (code2) => {
          setLoading(true);
          await onDelete(code2);
          setLoading(false);
        }, "deleteInviteCode");
        return html34`
        <div class="invite-code invite-${code.use_type.toLowerCase()}">
            <h3> <${UseTypeIcon} /> ${label} </h3>
            <p class="invite-code-date date"> ${new Date(code.created_at).toLocaleString()} </p>
            ${createdByMe ? null : html34`
            <p class="invite-code-created-by">
                <${UserSpan_default} slug=${slug} userId=${createdBy} isMe=${createdByMe} />
            </p>
            `}
            <p class="invite-code-body">
                <a href="${linkTarget}" target="_blank">
                    ${fullLinkTarget}
                </a>
            </p>
            <${Button_default} onClick=${() => {
          navigator.clipboard.writeText(fullLinkTarget);
        }}> Copy Link to Clipboard </${Button_default}>
            <${Button_default} loading=${loading} onClick=${() => {
          deleteInviteCode(code.invite_code);
        }}> Delete </${Button_default}>
        </div>
    `;
      }, "InviteCode");
      InviteCodeSection = /* @__PURE__ */ __name(({ slug }) => {
        let [error, setError] = d2(null);
        let [session, setSession] = d2(null);
        let [inviteCodes, setInviteCodes] = d2(null);
        let { url, path, query, route } = useLocation();
        const { showToast } = useToast();
        let [singleUseLoading, setSingleUseLoading] = d2(false);
        let [unlimitedLoading, setUnlimitedLoading] = d2(false);
        y2(() => {
          if (error) {
            console.error(error);
          }
        }, [error]);
        y2(async () => {
          try {
            let session2 = await window.Data.session.getSession({ slug });
            setSession(session2);
            let inviteCodes2 = await window.Data.invitecode.getInviteCodes({ slug });
            setInviteCodes(inviteCodes2);
          } catch (e3) {
            setError(e3.message);
          }
        }, []);
        const createOnceInviteCode = /* @__PURE__ */ __name(async () => {
          setSingleUseLoading(true);
          try {
            let code = await window.Data.invitecode.createInviteCode({ slug, use_type: "once" });
            showToast("Invite code created!", { variation: "success" });
            setInviteCodes([code, ...inviteCodes]);
          } catch (e3) {
            setError(e3.message);
          }
          setSingleUseLoading(false);
        }, "createOnceInviteCode");
        const createUnlimitedInviteCode = /* @__PURE__ */ __name(async () => {
          setUnlimitedLoading(true);
          try {
            let code = await window.Data.invitecode.createInviteCode({ slug, use_type: "unlimited" });
            showToast("Invite code created!", { variation: "success" });
            console.dir(code);
            setInviteCodes([code, ...inviteCodes]);
          } catch (e3) {
            setError(e3.message);
          }
          setUnlimitedLoading(false);
        }, "createUnlimitedInviteCode");
        const deleteInviteCode = /* @__PURE__ */ __name(async (code) => {
          try {
            await window.Data.invitecode.deleteInviteCode({ slug, code });
            showToast("Invite code deleted!", { variation: "success" });
            setInviteCodes(inviteCodes.filter((c3) => c3.invite_code !== code));
          } catch (e3) {
            setError(e3.message);
          }
        }, "deleteInviteCode");
        let inviteCodeList = null;
        if (inviteCodes) {
          inviteCodeList = inviteCodes.map((code) => {
            return html34`
                <${InviteCode2} slug=${slug} session=${session} code=${code} onDelete=${async () => deleteInviteCode(code.invite_code)} />
            `;
          });
        }
        if (!inviteCodes || inviteCodeList.length == 0) {
          inviteCodeList = html34`
            <${Alert_default} title="No Invite Codes" message="You have not created any invite codes yet."
                variant="null"/>
        `;
        }
        return html34`
        <h2> <small><a href=${`/community/${slug}/users`}>Users /</a></small>  Invite </h2>
        <hr/>
        <${Flexstack_default}>
            <${ButtonFrame_default} loading=${singleUseLoading} title="Create Single Use Invite Code" label="Create" onClick=${createOnceInviteCode}>
                <div>
                    <${Box} />
                </div>
                A Single-Use Invite Code will disappear after a single user uses it to create an account!
                ${session?.is_admin ? html34`Use it to tightly control access to your community!` : ""}
            <//>
            ${session?.is_admin ? html34`
            <${ButtonFrame_default} loading=${unlimitedLoading} title="Create Unlimited Invite Code" label="Create" onClick=${createUnlimitedInviteCode}>
                <div>
                    <${Boxes} />
                </div>
                An Unlimited Invite Code will never disappear! Use it to allow anyone to join your community!
            <//>
            ` : ""}
        <//>
        <${Alert_default} message=${error} />
        <hr/>
        ${inviteCodeList}
    `;
      }, "InviteCodeSection");
      InviteCodePage = /* @__PURE__ */ __name(({ slug }) => {
        return html34`
        <${CommunityHomePageLayout_default} slug=${slug} pageName="Invite Codes">
            <${InviteCodeSection} slug=${slug} />
        <//>
    `;
      }, "InviteCodePage");
      InviteCodePage_default = InviteCodePage;
    }
  });

  // pages/UserRegistrationPage.js
  var UserRegistrationPage_exports = {};
  __export(UserRegistrationPage_exports, {
    default: () => UserRegistrationPage_default
  });
  var html35, UserRegistrationPage, UserRegistrationPage_default;
  var init_UserRegistrationPage = __esm({
    "pages/UserRegistrationPage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_Button();
      init_Checkbox();
      init_Input();
      init_BasicPageLayout();
      init_Alert();
      html35 = htm_module_default.bind(_);
      UserRegistrationPage = /* @__PURE__ */ __name(({ slug, id }) => {
        let [session, setSession] = d2(null);
        let [community, setCommunity] = d2(null);
        let [error, setError] = d2(null);
        let [complete, setComplete] = d2(false);
        let [loading, setLoading] = d2(true);
        let [buttonLoading, setButtonLoading] = d2(false);
        let { url, path, query, route } = useLocation();
        y2(async () => {
          try {
            let session2 = await window.Data.session.getSession({ slug });
            setSession(session2);
          } catch (e3) {
          }
          try {
            let community2 = await window.Data.community.getCommunity({ slug });
            setCommunity(community2);
          } catch (e3) {
            setError(e3.message);
          }
          setLoading(false);
        }, []);
        const formSubmit = /* @__PURE__ */ __name(async (e3) => {
          setButtonLoading(true);
          e3.preventDefault();
          let form = e3.target;
          let formData = new FormData(form);
          let data = {};
          for (let key2 of formData.keys()) {
            data[key2] = formData.get(key2);
          }
          console.dir(data);
          let user = {
            name: data["employee-name"],
            email: data["user-email"] || null,
            phone_number: data["user-phone"] || null,
            password: data["user-password"],
            tos: data["community-terms"] == "on"
          };
          console.dir(user);
          console.warn("user", user.name);
          try {
            let invite_code = data["invite-code"];
            let created_user = await window.Data.user.createUser({ slug, user, invite_code });
            route(`/community/${slug}/verify`);
          } catch (e4) {
            setError(e4.message);
          } finally {
            setButtonLoading(false);
          }
        }, "formSubmit");
        const formTest = /* @__PURE__ */ __name((e3) => {
          let form = e3.target.closest("form");
          let formData = new FormData(form);
          let data = {};
          for (let key2 of formData.keys()) {
            data[key2] = formData.get(key2);
          }
          console.dir(data);
          let user = {
            invite_code: data["invite-code"],
            employee_name: data["employee-name"].trim(),
            email: data["user-email"].trim(),
            phone_number: data["user-phone"].trim(),
            password: data["user-password"].trim(),
            tos: data["community-terms"] == "on"
          };
          console.dir(user);
          if (!user.tos || !user.invite_code || !user.employee_name) {
            console.log("tos, invite_code, and employee_name are required");
            setComplete(false);
            return;
          }
          if (user.password && user.password.length < 8) {
            console.log("password is too short");
            setComplete(false);
            return;
          }
          if (!user.phone_number && !user.email && !user.password) {
            console.log("need at least one of phone number, email, or password");
            setComplete(false);
            return;
          }
          if (user.phone_number && user.phone_number.length < 9) {
            console.log("phone number is too short");
            setComplete(false);
            return;
          }
          if (user.name && user.name.length < 2) {
            console.log("name is too short");
            setComplete(false);
            return;
          }
          if (user.phone_number && !user.phone_number.match(/^[0-9 +-]+$/)) {
            console.log("phone number is numeric only");
            setComplete(false);
            return;
          }
          if (user.email && user.email.length > 0 && (!user.email.includes("@") || !user.email.includes("."))) {
            setComplete(false);
            return;
          }
          setComplete(true);
        }, "formTest");
        if (session) {
          let linkTarget = `/community/${slug}/invite/${id}`;
          let fullLinkTarget = `${window.location.origin}${linkTarget}`;
          return html35`
        <${BasicPageLayout_default} title="Registration Code">
            <h2>${id}</h2>
            <p>An employee needs this link to create an account</p>
            <p>
                <a href="${linkTarget}" target="_blank">
                    ${fullLinkTarget}
                </a>
            </p>
            <${Button_default} onClick=${() => {
            navigator.clipboard.writeText(fullLinkTarget);
          }}> Copy Link to Clipboard </${Button_default}>
        <//>
        `;
        }
        return html35`
    <${BasicPageLayout_default} loading=${loading} title="User Registration">

        <form onSubmit=${formSubmit}>
            <input type="hidden" id="invite-code" name="invite-code" value="${id}" />
            <${Input_default}
                id="employee-name"
                name="employee-name"
                label="Employee Name"
                placeholder="Em P. Lloyd"
                helpText="This is your name!"
                onChange=${formTest}
                required/>
            <br/>
            <${Input_default}
                type="email"
                id="user-email"
                name="user-email"
                label="Email (Optional)"
                placeholder="email@verygood.co"
                helpText="A verification email will be sent to this address. (You don't have to, but it's helpful if you forget your password)"
                onChange=${formTest}
                />
            <br/>
            <${Input_default}
                type="tel"
                id="user-phone"
                name="user-phone"
                label="Phone Number (Optional)"
                placeholder="1-604-555-1234"
                minlength="10"
                helpText="A verification SMS will be sent to this number. (You don't have to, but it's helpful if you forget your password)"
                onChange=${formTest}
                />
            <br/>
            <${Input_default}
                type="password"
                id="user-password"
                name="user-password"
                label="User Password"
                minlength="8"
                help-text="This password will be used to log in to your community account"
                onChange=${formTest}
                />
            <br/>
            <${Checkbox_default}
                id="community-terms"
                name="community-terms"
                onChange=${formTest}
                required>
                    I have read and agree to the <a href="/home/terms" onClick=${() => {
          route("/home/terms");
        }}>terms and conditions</a>.
                <//>

            <${Alert_default} message=${error} />

            <${Button_default} loading=${buttonLoading} type="submit" variant="primary" disabled=${!complete}>Create User Account<//>
        </form>
    </div>
    `;
      }, "UserRegistrationPage");
      UserRegistrationPage_default = UserRegistrationPage;
    }
  });

  // bips/PhoneNumber.js
  var html36, PhoneNumber, PhoneNumber_default;
  var init_PhoneNumber = __esm({
    "bips/PhoneNumber.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_lucide_preact();
      html36 = htm_module_default.bind(_);
      PhoneNumber = /* @__PURE__ */ __name(({ phoneNumber, verified = false }) => {
        let formattedNumber = phoneNumber;
        if (phoneNumber && phoneNumber.length === 11) {
          formattedNumber = `(${phoneNumber.slice(0, 3)}) ${phoneNumber.slice(3, 6)}-${phoneNumber.slice(6)}`;
        } else if (phoneNumber && phoneNumber.length === 10) {
          formattedNumber = `(${phoneNumber.slice(0, 3)}) ${phoneNumber.slice(3, 6)}-${phoneNumber.slice(6)}`;
        }
        return html36`
    <span class="phone-number">
        <${Phone} class="phone-number-icon" size="12" strokeWidth="3" />
        <a class="phone-number-link" href="tel:${phoneNumber}">
            ${formattedNumber ? formattedNumber : "???"}
        </a>
        ${verified ? html36`<${Check} class="phone-number-verified" size="16" strokeWidth="5" />` : html36`<${ShieldQuestionMark} class="phone-number-unverified" size="16" strokeWidth="5" />`}
    </span>
    `;
      }, "PhoneNumber");
      PhoneNumber_default = PhoneNumber;
    }
  });

  // bips/Email.js
  var html37, Email, Email_default;
  var init_Email = __esm({
    "bips/Email.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_lucide_preact();
      html37 = htm_module_default.bind(_);
      Email = /* @__PURE__ */ __name(({ email, verified = false }) => {
        return html37`
    <span class="email">
        <${Mail} class="email-icon" size="12" strokeWidth="3" />
        <a class="email-link" href="mailto:${email}">
            ${email ? email : "???"}
        </a>
        ${verified ? html37`<${Check} class="email-verified" size="16" strokeWidth="5" />` : html37`<${ShieldQuestionMark} class="email-unverified" size="16" strokeWidth="5" />`}

    </span>
    `;
      }, "Email");
      Email_default = Email;
    }
  });

  // bips/Tag.js
  var html38, tagToIcon, tagToName, tagToDescription, Tag, Tag_default;
  var init_Tag = __esm({
    "bips/Tag.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_lucide_preact();
      html38 = htm_module_default.bind(_);
      tagToIcon = {
        "owner": ShieldUser,
        "has_password": KeyRound,
        "has_phone": Phone,
        "phone_verified": PhoneIncoming,
        "has_email": Mail,
        "email_verified": MailCheck,
        "locked": Lock,
        "admin": UserCog,
        "super_admin": Superscript
      };
      tagToName = {
        "owner": "Owner",
        "has_password": "Has Password",
        "has_phone": "Has Phone Number",
        "phone_verified": "Phone Verified",
        "has_email": "Has Email Address",
        "email_verified": "Email Verified",
        "locked": "Locked",
        "admin": "Admin",
        "super_admin": "Super Admin"
      };
      tagToDescription = {
        "owner": "User is the owner",
        "has_password": "User has a password set",
        "has_phone": "User has a phone number set",
        "phone_verified": "User phone number is verified",
        "has_email": "User has an email address set",
        "email_verified": "User email address is verified",
        "locked": "User can not log in or access their account",
        "admin": "User has admin privileges",
        "super_admin": "User is a super-admin from outside the community"
      };
      Tag = /* @__PURE__ */ __name(({ tag: tag2 }) => {
        let icon2 = tagToIcon[tag2];
        if (!icon2) {
          console.warn(`No icon found for tag: ${tag2}`);
          icon2 = /* @__PURE__ */ __name(() => null, "icon");
        }
        let tagName = tagToName[tag2];
        if (!tagName) {
          console.warn(`No name found for tag: ${tag2}`);
          tagName = tag2;
        }
        let tagDescription = tagToDescription[tag2];
        if (!tagDescription) {
          console.warn(`No description found for tag: ${tag2}`);
          tagDescription = "No description available";
        }
        return html38`
    <span class="tag" title=${tagDescription}>
        <${icon2} class="tag-icon" size="16" strokeWidth="3" />
        <span class="tag-link">
            ${tagName}
        </span>

    </span>
    `;
      }, "Tag");
      Tag_default = Tag;
    }
  });

  // widgets/User/Change/ChangeName.js
  var html39, ChangeName, ChangeName_default;
  var init_ChangeName = __esm({
    "widgets/User/Change/ChangeName.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_Input();
      init_Button();
      init_Alert();
      init_ToastContext();
      html39 = htm_module_default.bind(_);
      ChangeName = /* @__PURE__ */ __name(({
        slug,
        onChange,
        defaultValue = "",
        ...props
      }) => {
        const [loading, setLoading] = d2(false);
        const [error, setError] = d2(null);
        const { showToast } = useToast();
        const changeName = /* @__PURE__ */ __name(async (e3) => {
          setLoading(true);
          const newName = e3.target.parentElement.querySelector("input").value.trim();
          if (newName === defaultValue) {
            return;
          }
          try {
            await window.Data.user.changeName({ slug, name: newName });
            showToast(`Okay ${newName}, your name is ${newName} now.`, { variation: "success" });
            onChange(newName);
          } catch (e4) {
            console.error(e4);
            setError(e4.message);
          }
          setLoading(false);
        }, "changeName");
        return html39`
        <div class="user-change-name-container">
            <${Input_default}
                type="text"
                label="New Name:"
                value=${defaultValue}
                ...${props} />
            <${Button_default} loading=${loading} onClick=${changeName} variant="primary">
                Save
            <//>
            <${Alert_default} type="error" message=${error} />
        </div>
    `;
      }, "ChangeName");
      ChangeName_default = ChangeName;
    }
  });

  // widgets/User/Change/ChangePassword.js
  var html40, ChangePassword, ChangePassword_default;
  var init_ChangePassword = __esm({
    "widgets/User/Change/ChangePassword.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_Input();
      init_Button();
      init_Alert();
      init_ToastContext();
      html40 = htm_module_default.bind(_);
      ChangePassword = /* @__PURE__ */ __name(({
        slug,
        onChange,
        ...props
      }) => {
        const [loading, setLoading] = d2(false);
        const [error, setError] = d2(null);
        const [valid, setValid] = d2(false);
        const { showToast } = useToast();
        const changePassword = /* @__PURE__ */ __name(async (e3) => {
          setLoading(true);
          const newPassword = e3.target.parentElement.querySelector("input").value.trim();
          if (newPassword === "") {
            return;
          }
          try {
            await window.Data.user.changePassword({ slug, password: newPassword });
            showToast("Password changed successfully!", { variation: "success" });
            onChange();
          } catch (e4) {
            console.error(e4);
            setError(e4.message);
          }
          setLoading(false);
        }, "changePassword");
        return html40`
        <div class="user-change-password-container">
            <${Input_default}
                type="password"
                label="New Password:"
                onValid=${() => setValid(true)}
                onInvalid=${() => setValid(false)}
                ...${props} />
            <${Button_default} loading=${loading} disabled=${!valid} onClick=${changePassword} variant="primary">
                Save
            <//>
            <${Alert_default} type="error" message=${error} />
        </div>
    `;
      }, "ChangePassword");
      ChangePassword_default = ChangePassword;
    }
  });

  // widgets/User/Change/ChangeEmail.js
  var html41, ChangeEmail, ChangeEmail_default;
  var init_ChangeEmail = __esm({
    "widgets/User/Change/ChangeEmail.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_Input();
      init_Button();
      init_Alert();
      init_ToastContext();
      html41 = htm_module_default.bind(_);
      ChangeEmail = /* @__PURE__ */ __name(({
        slug,
        userId,
        defaultValue,
        onChange,
        ...props
      }) => {
        const [loading, setLoading] = d2(false);
        const [error, setError] = d2(null);
        const [valid, setValid] = d2(false);
        const [verifyMode, setVerifyMode] = d2(false);
        const { showToast } = useToast();
        const changeEmail = /* @__PURE__ */ __name(async (e3) => {
          setLoading(true);
          const newEmail = e3.target.parentElement.querySelector("input").value.trim();
          if (newEmail === "" || newEmail === defaultValue) {
            return;
          }
          try {
            await window.Data.user.changeEmail({ slug, email: newEmail });
            showToast("Email change initiated! Please check your email for a verification code.", { variation: "primary" });
            setVerifyMode(true);
            setValid(false);
          } catch (e4) {
            console.error(e4);
            setError(e4.message);
          }
          setLoading(false);
        }, "changeEmail");
        const verifyEmail = /* @__PURE__ */ __name(async (e3) => {
          setLoading(true);
          try {
            let verificationCode = e3.target.parentElement.querySelector("input").value.trim();
            if (!verificationCode) {
              throw new Error("Verification code is required.");
            }
            await window.Data.verify.verifyEmailVerificationCode({ slug, user_id: userId, code: verificationCode });
            showToast("Email verified successfully!", { variation: "success" });
            onChange();
          } catch (e4) {
            console.error(e4);
            setError(e4.message);
          }
          setLoading(false);
        }, "verifyEmail");
        if (!verifyMode) {
          return html41`
            <div class="user-change-email-container">
                <${Input_default}
                    type="email"
                    label="New Email:"
                    value=${defaultValue}
                    onValid=${() => setValid(true)}
                    onInvalid=${() => setValid(false)}
                    />
                <${Button_default} loading=${loading} disabled=${!valid} onClick=${changeEmail} variant="primary">
                    Save
                <//>
                <${Alert_default} type="error" message=${error} />
            </div>
        `;
        } else {
          return html41`
            <div class="user-verify-email-container">
                <${Input_default}
                    type="vercode"
                    label="Email Verification Code:"
                    onValid=${() => setValid(true)}
                    onInvalid=${() => setValid(false)}
                    />
                <${Button_default} loading=${loading} disabled=${!valid} onClick=${verifyEmail} variant="primary">
                    Verify
                <//>
                <${Button_default} onClick=${() => setVerifyMode(false)}>
                    Cancel
                <//>
                <${Alert_default} type="error" message=${error} />
            </div>
        `;
        }
      }, "ChangeEmail");
      ChangeEmail_default = ChangeEmail;
    }
  });

  // widgets/User/Change/ChangePhone.js
  var html42, ChangePhone, ChangePhone_default;
  var init_ChangePhone = __esm({
    "widgets/User/Change/ChangePhone.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_Input();
      init_Button();
      init_Alert();
      init_ToastContext();
      html42 = htm_module_default.bind(_);
      ChangePhone = /* @__PURE__ */ __name(({
        slug,
        userId,
        defaultValue,
        onChange
      }) => {
        const [loading, setLoading] = d2(false);
        const [error, setError] = d2(null);
        const [valid, setValid] = d2(false);
        const [verifyMode, setVerifyMode] = d2(false);
        const { showToast } = useToast();
        const changePhone = /* @__PURE__ */ __name(async (e3) => {
          setLoading(true);
          const newPhone = e3.target.parentElement.querySelector("input").value.trim();
          if (newPhone === "" || newPhone === defaultValue) {
            return;
          }
          try {
            await window.Data.user.changePhone({ slug, phone_number: newPhone });
            setVerifyMode(true);
            setValid(false);
            e3.target.parentElement.querySelector("input").value = "";
            showToast("Phone change initiated! Please check your phone for a verification code.", { variation: "primary" });
          } catch (e4) {
            console.error(e4);
            setError(e4.message);
          }
          setLoading(false);
        }, "changePhone");
        const verifyPhone = /* @__PURE__ */ __name(async (e3) => {
          setLoading(true);
          try {
            let verificationCode = e3.target.parentElement.querySelector("input").value.trim();
            if (!verificationCode) {
              throw new Error("Verification code is required.");
            }
            await window.Data.verify.verifySmsVerificationCode({ slug, user_id: userId, code: verificationCode });
            showToast("Phone verified successfully!", { variation: "success" });
            onChange();
          } catch (e4) {
            console.error(e4);
            setError(e4.message);
          }
          setLoading(false);
        }, "verifyPhone");
        if (!verifyMode) {
          return html42`
            <div class="user-change-phone-container">
                <${Input_default}
                    type="tel"
                    label="New Phone:"
                    value=${defaultValue}
                    onValid=${() => setValid(true)}
                    onInvalid=${() => setValid(false)}
                    />
                <${Button_default} loading=${loading} disabled=${!valid} onClick=${changePhone} variant="primary">
                    Save
                <//>
                <${Alert_default} type="error" message=${error} />
            </div>
        `;
        } else {
          return html42`
            <div class="user-verify-phone-container">
                <${Input_default}
                    type="vercode"
                    label="Phone Verification Code:"
                    value=""
                    onValid=${() => setValid(true)}
                    onInvalid=${() => setValid(false)}
                    />
                <${Button_default} loading=${loading} disabled=${!valid} onClick=${verifyPhone} variant="primary">
                    Verify
                <//>
                <${Button_default} onClick=${() => setVerifyMode(false)}>
                    Cancel
                <//>
                <${Alert_default} type="error" message=${error} />
            </div>
        `;
        }
      }, "ChangePhone");
      ChangePhone_default = ChangePhone;
    }
  });

  // widgets/User/Change/LockUser.js
  var html43, LockUser, LockUser_default;
  var init_LockUser = __esm({
    "widgets/User/Change/LockUser.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_Button();
      init_Alert();
      init_ToastContext();
      html43 = htm_module_default.bind(_);
      LockUser = /* @__PURE__ */ __name(({
        slug,
        userId,
        locked,
        onChange
      }) => {
        const [loading, setLoading] = d2(false);
        const [error, setError] = d2(null);
        const { showToast } = useToast();
        const toggleLock = /* @__PURE__ */ __name(async (e3) => {
          setLoading(true);
          try {
            if (locked) {
              await window.Data.user.unlockUser({ slug, user_id: userId });
              showToast("User unlocked!", { variation: "success" });
            } else {
              await window.Data.user.lockUser({ slug, user_id: userId });
              showToast("User locked!", { variation: "success" });
            }
            onChange();
          } catch (e4) {
            console.error(e4);
            setError(e4.message);
          }
          setLoading(false);
        }, "toggleLock");
        let lock = "Lock";
        if (locked) {
          lock = "Unlock";
        }
        return html43`
        <div class="user-change-lock-container">
            <p>If a user is locked, they will not be able to log in or access their account.</p>
            <${Button_default} loading=${loading} onClick=${toggleLock} variant="primary">
                ${lock} User
            <//>
            <${Alert_default} type="error" message=${error} />
        </div>
    `;
      }, "LockUser");
      LockUser_default = LockUser;
    }
  });

  // widgets/User/Change/DeleteUser.js
  var html44, DeleteUser, DeleteUser_default;
  var init_DeleteUser = __esm({
    "widgets/User/Change/DeleteUser.js"() {
      init_preact_module();
      init_hooks_module();
      init_src();
      init_htm_module();
      init_Input();
      init_Button();
      init_Alert();
      init_ToastContext();
      html44 = htm_module_default.bind(_);
      DeleteUser = /* @__PURE__ */ __name(({
        slug,
        userId,
        defaultValue = ""
      }) => {
        const [loading, setLoading] = d2(false);
        const [valid, setValid] = d2(false);
        const [error, setError] = d2(null);
        const { showToast } = useToast();
        let { url, path, query, route } = useLocation();
        const deleteUser = /* @__PURE__ */ __name(async (e3) => {
          setLoading(true);
          const confirmText = e3.target.parentElement.querySelector("input").value.trim().toLowerCase();
          if (confirmText !== "i understand") {
            setValid(false);
            return;
          }
          try {
            showToast("User deleted successfully!", { variation: "warning" });
            await window.Data.user.deleteUser({ slug, user_id: userId });
            route(`/community/${slug}/users/`);
          } catch (e4) {
            console.error(e4);
            setError(e4.message);
          }
          setLoading(false);
        }, "deleteUser");
        return html44`
        <div class="user-change-name-container">
            <p>Are you sure you want to delete this user? This action cannot be undone.</p>
            <${Input_default}
                type="text"
                regex="^i understand$"
                label="Please type 'i understand' to confirm:"
                onValid=${() => setValid(true)}
                onInvalid=${() => setValid(false)}
                />
            <${Button_default} loading=${loading} disabled=${!valid} onClick=${deleteUser} variant="warning">
                Delete
            <//>
            <${Alert_default} type="error" message=${error} />
        </div>
    `;
      }, "DeleteUser");
      DeleteUser_default = DeleteUser;
    }
  });

  // widgets/User/Change/AdminUser.js
  var html45, AdminUser, AdminUser_default;
  var init_AdminUser = __esm({
    "widgets/User/Change/AdminUser.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_Button();
      init_Alert();
      init_ToastContext();
      html45 = htm_module_default.bind(_);
      AdminUser = /* @__PURE__ */ __name(({
        slug,
        userId,
        isUserAdmin,
        onChange
      }) => {
        const [loading, setLoading] = d2(false);
        const [error, setError] = d2(null);
        const { showToast } = useToast();
        const toggleAdmin = /* @__PURE__ */ __name(async (e3) => {
          setLoading(true);
          try {
            if (isUserAdmin) {
              await window.Data.user.unadminUser({ slug, user_id: userId });
              showToast("Admin removed!", { variation: "success" });
            } else {
              await window.Data.user.adminUser({ slug, user_id: userId });
              showToast("Admin added!", { variation: "success" });
            }
            onChange();
          } catch (e4) {
            console.error(e4);
            setError(e4.message);
          }
          setLoading(false);
        }, "toggleAdmin");
        let admin = "Admin";
        if (isUserAdmin) {
          admin = "Unadmin";
        }
        return html45`
        <div class="user-change-lock-container">
            <p>The admin user has all of the same privileges as an owner: they can invite users,
                see all accounts, lock and delete accounts, change community settings, etc.</p>
            <${Button_default} loading=${loading} onClick=${toggleAdmin} variant="primary">
                ${admin} User
            <//>
            <${Alert_default} type="error" message=${error} />
        </div>
    `;
      }, "AdminUser");
      AdminUser_default = AdminUser;
    }
  });

  // widgets/User/User.js
  var html46, User2, User_default;
  var init_User = __esm({
    "widgets/User/User.js"() {
      init_preact_module();
      init_htm_module();
      init_src();
      init_PhoneNumber();
      init_Email();
      init_Tag();
      init_Flexstack();
      init_Button();
      init_Collapsibro();
      init_Gravatar();
      init_ChangeName();
      init_ChangePassword();
      init_ChangeEmail();
      init_ChangePhone();
      init_LockUser();
      init_DeleteUser();
      init_AdminUser();
      html46 = htm_module_default.bind(_);
      User2 = /* @__PURE__ */ __name(({ user, communitySlug, slim, onUserChange, isMe = false, isAdmin = false }) => {
        let { url, path, query, route } = useLocation();
        if (onUserChange == null) {
          onUserChange = /* @__PURE__ */ __name(() => {
          }, "onUserChange");
        }
        let {
          id,
          slug,
          name,
          email,
          phone_number,
          tags,
          created_at,
          updated_at
        } = user;
        let filteredTags = tags || [];
        let emailVerified = filteredTags.includes("email_verified");
        let phoneVerified = filteredTags.includes("phone_verified");
        let locked = filteredTags.includes("locked");
        let lockText = locked ? "Unlock User" : "Lock User";
        let isUserAdmin = filteredTags.includes("admin") || filteredTags.includes("super_admin") || filteredTags.includes("owner");
        let adminText = isUserAdmin ? "Remove User Admin" : "Make User Admin";
        let canRemoveAdmin = !filteredTags.includes("owner") && !filteredTags.includes("super_admin");
        let canDeleteUser = !filteredTags.includes("owner") && !filteredTags.includes("super_admin");
        let userLink = `/community/${communitySlug}/users/${slug}`;
        if (isMe) {
          userLink = `/community/${communitySlug}/profile`;
        }
        if (slim) {
          return html46`
        <div class="user-card ${isMe ? "user-card-me" : ""} user-card-slim slim">
            <${Flexstack_default}>
                <span class="user-gravatar">
                    <a href=${userLink}>
                        <!-- because we only have a "real" email for the user if they're... us, the Gravatar instructions are different -->
                        ${isMe ? html46`<${Gravatar_default} hashable=${user.email} defaultType="wavatar" title=${name} />` : html46`<${Gravatar_default} hashable=${user.id} overrideSha=${user.email} defaultType="wavatar" title=${name} />`}
                    </a>
                </span>
                <span class="user-tags">
                    ${filteredTags.map((tag2) => html46`<${Tag_default} tag=${tag2} slim=${true} />`)}
                </span>
                <span class="user-name">
                    <a href="${userLink}">${name}</a>
                </span>
            <//>
        </div>
        `;
        }
        return html46`
    <div class="user-card ${isMe ? "user-card-me" : ""}">
        <h3><a href="${userLink}">${name}</a></h3>
        <p class="user-card-id"><small>${slug} (${id})</small></p>
        <!-- Only admins can see the full user card -->
        ${isAdmin ? html46`
            <${Flexstack_default}>
                <div class="user-card-info">
                    <h4>User Info</h4>
                    <table class="user-card-table">
                        <tbody>
                            ${isMe && html46`
                                <tr>
                                    <th>Email:</th>
                                    <td>${email ? html46`<${Email_default} email=${email} verified=${emailVerified} />` : "N/A"}</td>
                                </tr>
                                <tr>
                                    <th>Phone:</th>
                                    <td>${phone_number ? html46`<${PhoneNumber_default} phoneNumber=${phone_number} verified="${phoneVerified}" />` : "N/A"}</td>
                                </tr>
                            `}
                            <tr>
                                <th>Created:</th>
                                <td>${new Date(created_at).toLocaleDateString()}</td>
                            </tr>
                            <tr>
                                <th>Updated:</th>
                                <td>${new Date(updated_at).toLocaleDateString()}</td>
                            </tr>
                            <tr>
                                <th>Last Login:</th>
                                <td>${user.last_login ? new Date(user.last_login).toLocaleDateString() : "N/A"}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div>
                    <h4>User Tags</h4>
                    <p><ul class="user-tags">${filteredTags.map((tag2) => html46`<li><${Tag_default} tag=${tag2} /></li>`)}</ul></p>
                </div>
            <//>` : ""}
        <!-- Only admins can see admin actions -->
        ${isAdmin ? html46`
            <h4>Admin Actions</h4>

            <${Collapsibro_default} variant="default" title="User Logs">
                <div>
                    <${Button_default} onClick=${() => route(`/community/${communitySlug}/audit?user_id=${id}`)}>User Logs<//>
                    <${Button_default} onClick=${() => route(`/community/${communitySlug}/audit?triggered_by=${id}`)}>User Admin Actions<//>
                </div>
            <//>
        ` : ""}
        ${isAdmin && !isMe ? html46`
            <${Collapsibro_default} variant="default" title="${adminText}" visible=${canRemoveAdmin}>
                <div>
                    <${AdminUser_default} slug=${communitySlug} userId=${id} isUserAdmin=${isUserAdmin} onChange=${onUserChange} />
                </div>
            <//>
            <${Collapsibro_default} variant="warning" title="${lockText}" visible=${canDeleteUser}>
                <div>
                    <${LockUser_default} slug=${communitySlug} userId=${id} locked=${locked} onChange=${onUserChange} />
                </div>
            <//>
            <${Collapsibro_default} variant="warning" title="Delete User" visible=${canDeleteUser}>
                <div>
                    <${DeleteUser_default} slug=${communitySlug} userId=${id} onChange=${onUserChange} />
                </div>
            <//>
        ` : ""}
        <!-- The things I can do to myself -->
        ${isMe ? html46`
            <h4>Account Settings</h4>
            <${Collapsibro_default} title="Logout">
                <div>
                    <${Button_default} onClick=${() => route(`/community/${communitySlug}/logout`)}>Logout<//>
                </div>
            <//>
            <${Collapsibro_default} title="Change Name">
                <div>
                    <${ChangeName_default} slug=${communitySlug} defaultValue=${name} onChange=${onUserChange} />
                </div>
            <//>
            <${Collapsibro_default} title="Change Password">
                <div>
                    <${ChangePassword_default} slug=${communitySlug} onChange=${onUserChange} />
                </div>
            <//>
            <${Collapsibro_default} title="Change Email">
                <div>
                    <${ChangeEmail_default} slug=${communitySlug} userId=${id} defaultValue=${email} onChange=${onUserChange} />
                </div>
            <//>
            <${Collapsibro_default} title="Change Phone Number">
                <div>
                    <${ChangePhone_default} slug=${communitySlug} userId=${id} defaultValue=${phone_number} onChange=${onUserChange} />
                </div>
            <//>
        ` : ""}

    </div>
    `;
      }, "User");
      User_default = User2;
    }
  });

  // pages/Community/CommunityUsersPage.js
  var CommunityUsersPage_exports = {};
  __export(CommunityUsersPage_exports, {
    default: () => CommunityUsersPage_default
  });
  var html47, CommunityUsersPage, CommunityUsersPage_default;
  var init_CommunityUsersPage = __esm({
    "pages/Community/CommunityUsersPage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_lucide_preact();
      init_CommunityHomePageLayout();
      init_Alert();
      init_Button();
      init_Searchbar();
      init_User();
      html47 = htm_module_default.bind(_);
      CommunityUsersPage = /* @__PURE__ */ __name(({ slug }) => {
        let [error, setError] = d2(null);
        let [session, setSession] = d2(null);
        let [users, setUsers] = d2([]);
        let [communitySettings, setCommunitySettings] = d2({});
        let [currentUserId, setCurrentUserId] = d2(null);
        let [visibleUsers, setVisibleUsers] = d2([]);
        let [loading, setLoading] = d2(true);
        let { url, path, query, route } = useLocation();
        y2(() => {
          const fetchUsers = /* @__PURE__ */ __name(async () => {
            try {
              let session2 = await window.Data.session.getSession({ slug });
              setSession(session2);
              setCurrentUserId(session2.user_id);
              let resp = await window.Data.user.listUsers({ slug });
              setUsers(resp);
              setVisibleUsers(resp);
              let settings = await window.Data.community.getCommunitySettings({ slug });
              setCommunitySettings(settings);
            } catch (e3) {
              setError(e3.message);
            } finally {
              setLoading(false);
            }
          }, "fetchUsers");
          fetchUsers();
        }, []);
        updateSearch = /* @__PURE__ */ __name((evt) => {
          console.log("Search term:", evt.target.value);
          let searchTerm = evt.target.value.toLowerCase();
          if (searchTerm) {
            let filteredUsers = users.filter((user) => {
              if (!user) return false;
              if (user.name && user.name.toLowerCase().includes(searchTerm)) return true;
              if (user.email && user.email.toLowerCase().includes(searchTerm)) return true;
              if (user.phone_number && user.phone_number.toLowerCase().includes(searchTerm)) return true;
              if (user.tags && user.tags.some((tag2) => tag2.toLowerCase().includes(searchTerm))) return true;
              return false;
            });
            setVisibleUsers(filteredUsers);
          } else {
            setVisibleUsers(users);
          }
        }, "updateSearch");
        sortUsersWithOrder = /* @__PURE__ */ __name((sortOrder) => {
          let sortedUsers = [...visibleUsers].sort((a3, b2) => {
            if (sortOrder === "name a-z") {
              if (a3.name && !b2.name) return -1;
              if (!a3.name && b2.name) return 1;
              if (!a3.name && !b2.name) return 0;
              return a3?.name.localeCompare(b2.name || "");
            } else if (sortOrder === "name z-a") {
              if (a3.name && !b2.name) return 1;
              if (!a3.name && b2.name) return -1;
              if (!a3.name && !b2.name) return 0;
              return b2?.name.localeCompare(a3.name || "");
            } else if (sortOrder === "email a-z") {
              if (a3.email && !b2.email) return -1;
              if (!a3.email && b2.email) return 1;
              if (!a3.email && !b2.email) return 0;
              return a3?.email.localeCompare(b2.email || "");
            } else if (sortOrder === "email z-a") {
              if (a3.email && !b2.email) return 1;
              if (!a3.email && b2.email) return -1;
              if (!a3.email && !b2.email) return 0;
              return b2?.email.localeCompare(a3.email || "");
            } else if (sortOrder === "created_at newest first") {
              return new Date(b2.created_at) - new Date(a3.created_at);
            } else if (sortOrder === "created_at oldest first") {
              return new Date(a3.created_at) - new Date(b2.created_at);
            } else if (sortOrder === "updated_at newest first") {
              return new Date(b2.updated_at) - new Date(a3.updated_at);
            } else if (sortOrder === "updated_at oldest first") {
              return new Date(a3.updated_at) - new Date(b2.updated_at);
            } else if (sortOrder === "last_login newest first") {
              return new Date(b2.last_login) - new Date(a3.last_login);
            } else if (sortOrder === "last_login oldest first") {
              return new Date(a3.last_login) - new Date(b2.last_login);
            }
            return 0;
          });
          setVisibleUsers(sortedUsers);
        }, "sortUsersWithOrder");
        sortUsers = /* @__PURE__ */ __name((evt) => {
          let sortOrder = evt.target.value;
          console.log("Sort order:", sortOrder);
          sortUsersWithOrder(sortOrder);
        }, "sortUsers");
        return html47`
    <${CommunityHomePageLayout_default} loading=${loading} slug=${slug} pageName="Users">
        <h2>Users</h2>

        <${Searchbar_default} onChange=${updateSearch} />

        <!-- select a sort order from a dropdown -->
        <div class="users-options">
            <div class="bip-sort-order">
                <label for="sort-order">Sort by:</label>
                <select id="sort-order" onChange=${sortUsers}>
                    <option value="name a-z">Name A-Z</option>
                    <option value="name z-a">Name Z-A</option>
                    <option value="email a-z">Email A-Z</option>
                    <option value="email z-a">Email Z-A</option>
                    <option value="created_at newest first">Created At (Newest First)</option>
                    <option value="created_at oldest first">Created At (Oldest First)</option>
                    <option value="updated_at newest first">Last Update (Most Recent First)</option>
                    <option value="updated_at oldest first">Last Update (Least Recent First)</option>
                    <option value="last_login newest first">Last Login (Most Recent First)</option>
                    <option value="last_login oldest first">Last Login (Least Recent First)</option>
                </select>
            </div>

            ${session?.is_admin || communitySettings?.viral_growth_enabled ? html47`
                <div class="invite-button">
                    <${Button_default} variant="primary" onClick=${() => route(`/community/${slug}/invite`)}><${UserRoundPlus} //> Invite People to Community<//>
                </div>
            ` : ""}
        </div>

        <${Alert_default} type="error" message=${error} />

        ${visibleUsers?.map((user) => html47`
            <${User_default} user=${user} communitySlug=${slug} isMe=${currentUserId === user.id} slim=${true} isAdmin=${session.is_admin} />
        `)}

    <//>
    `;
      }, "CommunityUsersPage");
      CommunityUsersPage_default = CommunityUsersPage;
    }
  });

  // pages/Community/UserPage.js
  var UserPage_exports = {};
  __export(UserPage_exports, {
    default: () => UserPage_default
  });
  var html48, CommunityUsersPage2, UserPage_default;
  var init_UserPage = __esm({
    "pages/Community/UserPage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_CommunityHomePageLayout();
      init_Alert();
      init_User();
      html48 = htm_module_default.bind(_);
      CommunityUsersPage2 = /* @__PURE__ */ __name(({ slug, userSlug }) => {
        let [error, setError] = d2(null);
        let [session, setSession] = d2(null);
        let [user, setUser] = d2(null);
        let [loading, setLoading] = d2(true);
        let { url, path, query, route } = useLocation();
        y2(() => {
          const fetchUsers = /* @__PURE__ */ __name(async () => {
            try {
              let session2 = await window.Data.session.getSession({ slug });
              setSession(session2);
              let user2 = await window.Data.user.getUserBySlug({ slug, userSlug });
              setUser(user2);
            } catch (e3) {
              setError(e3.message);
            } finally {
              setLoading(false);
            }
          }, "fetchUsers");
          fetchUsers();
        }, []);
        const userHasChanged = /* @__PURE__ */ __name(async () => {
          try {
            let user2 = await window.Data.user.getUserBySlug({ slug, userSlug });
            setUser(user2);
          } catch (e3) {
            setError(e3.message);
          } finally {
            setLoading(false);
          }
        }, "userHasChanged");
        return html48`
    <${CommunityHomePageLayout_default} loading=${loading} slug=${slug} pageName=${user?.name || "User"}>
        <h2><small><a href="/community/${slug}/users/">Users</a></small> / ${user ? user.name : ""}</h2>

        <${Alert_default} type="error" message=${error} />

        ${user ? html48`<${User_default}
            user=${user}
            communitySlug=${slug}
            onUserChange=${userHasChanged}
            isMe=${user.user_id === session.user_id}
            isAdmin=${session.is_admin}
            />` : null}
    <//>
    `;
      }, "CommunityUsersPage");
      UserPage_default = CommunityUsersPage2;
    }
  });

  // pages/Community/ProfilePage.js
  var ProfilePage_exports = {};
  __export(ProfilePage_exports, {
    default: () => ProfilePage_default
  });
  var html49, CommunityUsersPage3, ProfilePage_default;
  var init_ProfilePage = __esm({
    "pages/Community/ProfilePage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_CommunityHomePageLayout();
      init_Alert();
      init_Searchbar();
      init_User();
      html49 = htm_module_default.bind(_);
      CommunityUsersPage3 = /* @__PURE__ */ __name(({ slug }) => {
        let [error, setError] = d2(null);
        let [session, setSession] = d2(null);
        let [user, setUser] = d2(null);
        let [loading, setLoading] = d2(true);
        let { url, path, query, route } = useLocation();
        y2(() => {
          const fetchUsers = /* @__PURE__ */ __name(async () => {
            try {
              let session2 = await window.Data.session.getSession({ slug });
              setSession(session2);
              let user2 = await window.Data.user.getUser({ slug, userId: session2.user_id });
              setUser(user2);
            } catch (e3) {
              setError(e3.message);
            } finally {
              setLoading(false);
            }
          }, "fetchUsers");
          fetchUsers();
        }, []);
        const userHasChanged = /* @__PURE__ */ __name(async () => {
          setLoading(true);
          try {
            let user2 = await window.Data.user.getUser({ slug, userId: session.user_id });
            setUser(user2);
          } catch (e3) {
            setError(e3.message);
          } finally {
            setLoading(false);
          }
        }, "userHasChanged");
        return html49`
    <${CommunityHomePageLayout_default} loading=${loading} slug=${slug} pageName="Profile">
        <h2>Profile</h2>

        <${Alert_default} type="error" message=${error} />

        ${user ? html49`<${User_default} user=${user} communitySlug=${slug} onUserChange=${userHasChanged} isMe=${true} isAdmin=${session.is_admin} />` : null}
    <//>
    `;
      }, "CommunityUsersPage");
      ProfilePage_default = CommunityUsersPage3;
    }
  });

  // node_modules/dayjs/dayjs.min.js
  var require_dayjs_min = __commonJS({
    "node_modules/dayjs/dayjs.min.js"(exports, module) {
      !function(t4, e3) {
        "object" == typeof exports && "undefined" != typeof module ? module.exports = e3() : "function" == typeof define && define.amd ? define(e3) : (t4 = "undefined" != typeof globalThis ? globalThis : t4 || self).dayjs = e3();
      }(exports, function() {
        "use strict";
        var t4 = 1e3, e3 = 6e4, n3 = 36e5, r3 = "millisecond", i3 = "second", s3 = "minute", u3 = "hour", a3 = "day", o3 = "week", c3 = "month", f3 = "quarter", h3 = "year", d3 = "date", l3 = "Invalid Date", $3 = /^(\d{4})[-/]?(\d{1,2})?[-/]?(\d{0,2})[Tt\s]*(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?[.:]?(\d+)?$/, y3 = /\[([^\]]+)]|Y{1,4}|M{1,4}|D{1,2}|d{1,4}|H{1,2}|h{1,2}|a|A|m{1,2}|s{1,2}|Z{1,2}|SSS/g, M3 = { name: "en", weekdays: "Sunday_Monday_Tuesday_Wednesday_Thursday_Friday_Saturday".split("_"), months: "January_February_March_April_May_June_July_August_September_October_November_December".split("_"), ordinal: /* @__PURE__ */ __name(function(t5) {
          var e4 = ["th", "st", "nd", "rd"], n4 = t5 % 100;
          return "[" + t5 + (e4[(n4 - 20) % 10] || e4[n4] || e4[0]) + "]";
        }, "ordinal") }, m3 = /* @__PURE__ */ __name(function(t5, e4, n4) {
          var r4 = String(t5);
          return !r4 || r4.length >= e4 ? t5 : "" + Array(e4 + 1 - r4.length).join(n4) + t5;
        }, "m"), v3 = { s: m3, z: /* @__PURE__ */ __name(function(t5) {
          var e4 = -t5.utcOffset(), n4 = Math.abs(e4), r4 = Math.floor(n4 / 60), i4 = n4 % 60;
          return (e4 <= 0 ? "+" : "-") + m3(r4, 2, "0") + ":" + m3(i4, 2, "0");
        }, "z"), m: /* @__PURE__ */ __name(function t5(e4, n4) {
          if (e4.date() < n4.date()) return -t5(n4, e4);
          var r4 = 12 * (n4.year() - e4.year()) + (n4.month() - e4.month()), i4 = e4.clone().add(r4, c3), s4 = n4 - i4 < 0, u4 = e4.clone().add(r4 + (s4 ? -1 : 1), c3);
          return +(-(r4 + (n4 - i4) / (s4 ? i4 - u4 : u4 - i4)) || 0);
        }, "t"), a: /* @__PURE__ */ __name(function(t5) {
          return t5 < 0 ? Math.ceil(t5) || 0 : Math.floor(t5);
        }, "a"), p: /* @__PURE__ */ __name(function(t5) {
          return { M: c3, y: h3, w: o3, d: a3, D: d3, h: u3, m: s3, s: i3, ms: r3, Q: f3 }[t5] || String(t5 || "").toLowerCase().replace(/s$/, "");
        }, "p"), u: /* @__PURE__ */ __name(function(t5) {
          return void 0 === t5;
        }, "u") }, g4 = "en", D4 = {};
        D4[g4] = M3;
        var p3 = "$isDayjsObject", S2 = /* @__PURE__ */ __name(function(t5) {
          return t5 instanceof _3 || !(!t5 || !t5[p3]);
        }, "S"), w4 = /* @__PURE__ */ __name(function t5(e4, n4, r4) {
          var i4;
          if (!e4) return g4;
          if ("string" == typeof e4) {
            var s4 = e4.toLowerCase();
            D4[s4] && (i4 = s4), n4 && (D4[s4] = n4, i4 = s4);
            var u4 = e4.split("-");
            if (!i4 && u4.length > 1) return t5(u4[0]);
          } else {
            var a4 = e4.name;
            D4[a4] = e4, i4 = a4;
          }
          return !r4 && i4 && (g4 = i4), i4 || !r4 && g4;
        }, "t"), O3 = /* @__PURE__ */ __name(function(t5, e4) {
          if (S2(t5)) return t5.clone();
          var n4 = "object" == typeof e4 ? e4 : {};
          return n4.date = t5, n4.args = arguments, new _3(n4);
        }, "O"), b2 = v3;
        b2.l = w4, b2.i = S2, b2.w = function(t5, e4) {
          return O3(t5, { locale: e4.$L, utc: e4.$u, x: e4.$x, $offset: e4.$offset });
        };
        var _3 = function() {
          function M4(t5) {
            this.$L = w4(t5.locale, null, true), this.parse(t5), this.$x = this.$x || t5.x || {}, this[p3] = true;
          }
          __name(M4, "M");
          var m4 = M4.prototype;
          return m4.parse = function(t5) {
            this.$d = function(t6) {
              var e4 = t6.date, n4 = t6.utc;
              if (null === e4) return /* @__PURE__ */ new Date(NaN);
              if (b2.u(e4)) return /* @__PURE__ */ new Date();
              if (e4 instanceof Date) return new Date(e4);
              if ("string" == typeof e4 && !/Z$/i.test(e4)) {
                var r4 = e4.match($3);
                if (r4) {
                  var i4 = r4[2] - 1 || 0, s4 = (r4[7] || "0").substring(0, 3);
                  return n4 ? new Date(Date.UTC(r4[1], i4, r4[3] || 1, r4[4] || 0, r4[5] || 0, r4[6] || 0, s4)) : new Date(r4[1], i4, r4[3] || 1, r4[4] || 0, r4[5] || 0, r4[6] || 0, s4);
                }
              }
              return new Date(e4);
            }(t5), this.init();
          }, m4.init = function() {
            var t5 = this.$d;
            this.$y = t5.getFullYear(), this.$M = t5.getMonth(), this.$D = t5.getDate(), this.$W = t5.getDay(), this.$H = t5.getHours(), this.$m = t5.getMinutes(), this.$s = t5.getSeconds(), this.$ms = t5.getMilliseconds();
          }, m4.$utils = function() {
            return b2;
          }, m4.isValid = function() {
            return !(this.$d.toString() === l3);
          }, m4.isSame = function(t5, e4) {
            var n4 = O3(t5);
            return this.startOf(e4) <= n4 && n4 <= this.endOf(e4);
          }, m4.isAfter = function(t5, e4) {
            return O3(t5) < this.startOf(e4);
          }, m4.isBefore = function(t5, e4) {
            return this.endOf(e4) < O3(t5);
          }, m4.$g = function(t5, e4, n4) {
            return b2.u(t5) ? this[e4] : this.set(n4, t5);
          }, m4.unix = function() {
            return Math.floor(this.valueOf() / 1e3);
          }, m4.valueOf = function() {
            return this.$d.getTime();
          }, m4.startOf = function(t5, e4) {
            var n4 = this, r4 = !!b2.u(e4) || e4, f4 = b2.p(t5), l4 = /* @__PURE__ */ __name(function(t6, e5) {
              var i4 = b2.w(n4.$u ? Date.UTC(n4.$y, e5, t6) : new Date(n4.$y, e5, t6), n4);
              return r4 ? i4 : i4.endOf(a3);
            }, "l"), $4 = /* @__PURE__ */ __name(function(t6, e5) {
              return b2.w(n4.toDate()[t6].apply(n4.toDate("s"), (r4 ? [0, 0, 0, 0] : [23, 59, 59, 999]).slice(e5)), n4);
            }, "$"), y4 = this.$W, M5 = this.$M, m5 = this.$D, v4 = "set" + (this.$u ? "UTC" : "");
            switch (f4) {
              case h3:
                return r4 ? l4(1, 0) : l4(31, 11);
              case c3:
                return r4 ? l4(1, M5) : l4(0, M5 + 1);
              case o3:
                var g5 = this.$locale().weekStart || 0, D5 = (y4 < g5 ? y4 + 7 : y4) - g5;
                return l4(r4 ? m5 - D5 : m5 + (6 - D5), M5);
              case a3:
              case d3:
                return $4(v4 + "Hours", 0);
              case u3:
                return $4(v4 + "Minutes", 1);
              case s3:
                return $4(v4 + "Seconds", 2);
              case i3:
                return $4(v4 + "Milliseconds", 3);
              default:
                return this.clone();
            }
          }, m4.endOf = function(t5) {
            return this.startOf(t5, false);
          }, m4.$set = function(t5, e4) {
            var n4, o4 = b2.p(t5), f4 = "set" + (this.$u ? "UTC" : ""), l4 = (n4 = {}, n4[a3] = f4 + "Date", n4[d3] = f4 + "Date", n4[c3] = f4 + "Month", n4[h3] = f4 + "FullYear", n4[u3] = f4 + "Hours", n4[s3] = f4 + "Minutes", n4[i3] = f4 + "Seconds", n4[r3] = f4 + "Milliseconds", n4)[o4], $4 = o4 === a3 ? this.$D + (e4 - this.$W) : e4;
            if (o4 === c3 || o4 === h3) {
              var y4 = this.clone().set(d3, 1);
              y4.$d[l4]($4), y4.init(), this.$d = y4.set(d3, Math.min(this.$D, y4.daysInMonth())).$d;
            } else l4 && this.$d[l4]($4);
            return this.init(), this;
          }, m4.set = function(t5, e4) {
            return this.clone().$set(t5, e4);
          }, m4.get = function(t5) {
            return this[b2.p(t5)]();
          }, m4.add = function(r4, f4) {
            var d4, l4 = this;
            r4 = Number(r4);
            var $4 = b2.p(f4), y4 = /* @__PURE__ */ __name(function(t5) {
              var e4 = O3(l4);
              return b2.w(e4.date(e4.date() + Math.round(t5 * r4)), l4);
            }, "y");
            if ($4 === c3) return this.set(c3, this.$M + r4);
            if ($4 === h3) return this.set(h3, this.$y + r4);
            if ($4 === a3) return y4(1);
            if ($4 === o3) return y4(7);
            var M5 = (d4 = {}, d4[s3] = e3, d4[u3] = n3, d4[i3] = t4, d4)[$4] || 1, m5 = this.$d.getTime() + r4 * M5;
            return b2.w(m5, this);
          }, m4.subtract = function(t5, e4) {
            return this.add(-1 * t5, e4);
          }, m4.format = function(t5) {
            var e4 = this, n4 = this.$locale();
            if (!this.isValid()) return n4.invalidDate || l3;
            var r4 = t5 || "YYYY-MM-DDTHH:mm:ssZ", i4 = b2.z(this), s4 = this.$H, u4 = this.$m, a4 = this.$M, o4 = n4.weekdays, c4 = n4.months, f4 = n4.meridiem, h4 = /* @__PURE__ */ __name(function(t6, n5, i5, s5) {
              return t6 && (t6[n5] || t6(e4, r4)) || i5[n5].slice(0, s5);
            }, "h"), d4 = /* @__PURE__ */ __name(function(t6) {
              return b2.s(s4 % 12 || 12, t6, "0");
            }, "d"), $4 = f4 || function(t6, e5, n5) {
              var r5 = t6 < 12 ? "AM" : "PM";
              return n5 ? r5.toLowerCase() : r5;
            };
            return r4.replace(y3, function(t6, r5) {
              return r5 || function(t7) {
                switch (t7) {
                  case "YY":
                    return String(e4.$y).slice(-2);
                  case "YYYY":
                    return b2.s(e4.$y, 4, "0");
                  case "M":
                    return a4 + 1;
                  case "MM":
                    return b2.s(a4 + 1, 2, "0");
                  case "MMM":
                    return h4(n4.monthsShort, a4, c4, 3);
                  case "MMMM":
                    return h4(c4, a4);
                  case "D":
                    return e4.$D;
                  case "DD":
                    return b2.s(e4.$D, 2, "0");
                  case "d":
                    return String(e4.$W);
                  case "dd":
                    return h4(n4.weekdaysMin, e4.$W, o4, 2);
                  case "ddd":
                    return h4(n4.weekdaysShort, e4.$W, o4, 3);
                  case "dddd":
                    return o4[e4.$W];
                  case "H":
                    return String(s4);
                  case "HH":
                    return b2.s(s4, 2, "0");
                  case "h":
                    return d4(1);
                  case "hh":
                    return d4(2);
                  case "a":
                    return $4(s4, u4, true);
                  case "A":
                    return $4(s4, u4, false);
                  case "m":
                    return String(u4);
                  case "mm":
                    return b2.s(u4, 2, "0");
                  case "s":
                    return String(e4.$s);
                  case "ss":
                    return b2.s(e4.$s, 2, "0");
                  case "SSS":
                    return b2.s(e4.$ms, 3, "0");
                  case "Z":
                    return i4;
                }
                return null;
              }(t6) || i4.replace(":", "");
            });
          }, m4.utcOffset = function() {
            return 15 * -Math.round(this.$d.getTimezoneOffset() / 15);
          }, m4.diff = function(r4, d4, l4) {
            var $4, y4 = this, M5 = b2.p(d4), m5 = O3(r4), v4 = (m5.utcOffset() - this.utcOffset()) * e3, g5 = this - m5, D5 = /* @__PURE__ */ __name(function() {
              return b2.m(y4, m5);
            }, "D");
            switch (M5) {
              case h3:
                $4 = D5() / 12;
                break;
              case c3:
                $4 = D5();
                break;
              case f3:
                $4 = D5() / 3;
                break;
              case o3:
                $4 = (g5 - v4) / 6048e5;
                break;
              case a3:
                $4 = (g5 - v4) / 864e5;
                break;
              case u3:
                $4 = g5 / n3;
                break;
              case s3:
                $4 = g5 / e3;
                break;
              case i3:
                $4 = g5 / t4;
                break;
              default:
                $4 = g5;
            }
            return l4 ? $4 : b2.a($4);
          }, m4.daysInMonth = function() {
            return this.endOf(c3).$D;
          }, m4.$locale = function() {
            return D4[this.$L];
          }, m4.locale = function(t5, e4) {
            if (!t5) return this.$L;
            var n4 = this.clone(), r4 = w4(t5, e4, true);
            return r4 && (n4.$L = r4), n4;
          }, m4.clone = function() {
            return b2.w(this.$d, this);
          }, m4.toDate = function() {
            return new Date(this.valueOf());
          }, m4.toJSON = function() {
            return this.isValid() ? this.toISOString() : null;
          }, m4.toISOString = function() {
            return this.$d.toISOString();
          }, m4.toString = function() {
            return this.$d.toUTCString();
          }, M4;
        }(), k4 = _3.prototype;
        return O3.prototype = k4, [["$ms", r3], ["$s", i3], ["$m", s3], ["$H", u3], ["$W", a3], ["$M", c3], ["$y", h3], ["$D", d3]].forEach(function(t5) {
          k4[t5[1]] = function(e4) {
            return this.$g(e4, t5[0], t5[1]);
          };
        }), O3.extend = function(t5, e4) {
          return t5.$i || (t5(e4, _3, O3), t5.$i = true), O3;
        }, O3.locale = w4, O3.isDayjs = S2, O3.unix = function(t5) {
          return O3(1e3 * t5);
        }, O3.en = D4[g4], O3.Ls = D4, O3.p = {}, O3;
      });
    }
  });

  // widgets/AuditTableRow/AuditTableRow.js
  var import_dayjs, html50, AuditTableRow, AuditTableRow_default;
  var init_AuditTableRow = __esm({
    "widgets/AuditTableRow/AuditTableRow.js"() {
      init_preact_module();
      init_hooks_module();
      init_src();
      import_dayjs = __toESM(require_dayjs_min());
      init_htm_module();
      init_UserSpan();
      init_Gravatar();
      html50 = htm_module_default.bind(_);
      AuditTableRow = /* @__PURE__ */ __name(({ slug, audit, session }) => {
        if (audit.forwarded_for === "--not forwarded--") {
          audit.forwarded_for = null;
        }
        let bestIp = audit.forwarded_for || audit.ip;
        let formattedDate = (0, import_dayjs.default)(audit.created_at).format("YYYY-MM-DD HH:mm:ss");
        let isMe = session.user_id === audit.user_id;
        return html50`
    <tr class="audit-table-row">
        <td class="audit-action">${audit.action}</td>
        <td class="audit-target"><${UserSpan_default} slug=${slug} userId=${audit.user_id} isMe=${isMe} /></td>
        <td class="audit-admin">
            ${audit.triggered_by ? html50`<${UserSpan_default} slug=${slug} userId=${audit.triggered_by} isMe=${isMe} />` : ""}
        </td>
        <td class="audit-timestamp">${formattedDate}</td>
        <td class="audit-ip">
            <${Gravatar_default} hashable=${bestIp} title=${bestIp} />
        </td>
    </tr>
    `;
      }, "AuditTableRow");
      AuditTableRow_default = AuditTableRow;
    }
  });

  // pages/Community/CommunityAuditPage.js
  var CommunityAuditPage_exports = {};
  __export(CommunityAuditPage_exports, {
    default: () => CommunityAuditPage_default
  });
  var html51, CommunityAuditPage, CommunityAuditPage_default;
  var init_CommunityAuditPage = __esm({
    "pages/Community/CommunityAuditPage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_AuditTableRow();
      init_CommunityHomePageLayout();
      init_Alert();
      init_Button();
      html51 = htm_module_default.bind(_);
      CommunityAuditPage = /* @__PURE__ */ __name(({ slug }) => {
        let [error, setError] = d2(null);
        let [session, setSession] = d2(null);
        let [audits, setAudits] = d2([]);
        let [loading, setLoading] = d2(true);
        let [n3, setN] = d2(100);
        let [moreResults, setMoreResults] = d2(true);
        let [offset, setOffset] = d2(0);
        let { url, path, query, route } = useLocation();
        y2(() => {
          const fetchAudits = /* @__PURE__ */ __name(async () => {
            try {
              console.dir(query);
              let session2 = await window.Data.session.getSession({ slug });
              setSession(session2);
              let resp = await window.Data.audit.getAudits({ slug, ...query, n: n3, offset });
              if (resp.length < n3) {
                setMoreResults(false);
              }
              setAudits(resp);
            } catch (e3) {
              setError(e3.message);
            } finally {
              setLoading(false);
            }
          }, "fetchAudits");
          fetchAudits();
        }, []);
        let more = /* @__PURE__ */ __name(async () => {
          setLoading(true);
          try {
            let newOffset = offset + n3;
            let resp = await window.Data.audit.getAudits({ slug, ...query, n: n3, offset: newOffset });
            setOffset(newOffset);
            if (resp.length < n3) {
              setMoreResults(false);
            }
            setAudits([...audits, ...resp]);
          } catch (e3) {
            setError(e3.message);
          } finally {
            setLoading(false);
          }
        }, "more");
        return html51`
    <${CommunityHomePageLayout_default} loading=${loading} slug=${slug} pageName="Users">
        <h2>Logs</h2>

        <${Alert_default} type="error" message=${error} />

        <table class="audit-table">
            <tr>
                <th>Type</th>
                <th>User</th>
                <th>Admin</th>
                <th>Time</th>
                <th class="audit-ip">IP</th>
            </tr>

            ${audits?.map((audit) => html51`
                <${AuditTableRow_default} slug=${slug} audit=${audit} key=${audit.id} session=${session} />
            `)}
        </table>

        ${moreResults && html51`<${Button_default} loading=${loading} onClick=${more}>Load More...<//>`}

    <//>
    `;
      }, "CommunityAuditPage");
      CommunityAuditPage_default = CommunityAuditPage;
    }
  });

  // node_modules/dayjs/plugin/relativeTime.js
  var require_relativeTime = __commonJS({
    "node_modules/dayjs/plugin/relativeTime.js"(exports, module) {
      !function(r3, e3) {
        "object" == typeof exports && "undefined" != typeof module ? module.exports = e3() : "function" == typeof define && define.amd ? define(e3) : (r3 = "undefined" != typeof globalThis ? globalThis : r3 || self).dayjs_plugin_relativeTime = e3();
      }(exports, function() {
        "use strict";
        return function(r3, e3, t4) {
          r3 = r3 || {};
          var n3 = e3.prototype, o3 = { future: "in %s", past: "%s ago", s: "a few seconds", m: "a minute", mm: "%d minutes", h: "an hour", hh: "%d hours", d: "a day", dd: "%d days", M: "a month", MM: "%d months", y: "a year", yy: "%d years" };
          function i3(r4, e4, t5, o4) {
            return n3.fromToBase(r4, e4, t5, o4);
          }
          __name(i3, "i");
          t4.en.relativeTime = o3, n3.fromToBase = function(e4, n4, i4, d4, u3) {
            for (var f3, a3, s3, l3 = i4.$locale().relativeTime || o3, h3 = r3.thresholds || [{ l: "s", r: 44, d: "second" }, { l: "m", r: 89 }, { l: "mm", r: 44, d: "minute" }, { l: "h", r: 89 }, { l: "hh", r: 21, d: "hour" }, { l: "d", r: 35 }, { l: "dd", r: 25, d: "day" }, { l: "M", r: 45 }, { l: "MM", r: 10, d: "month" }, { l: "y", r: 17 }, { l: "yy", d: "year" }], m3 = h3.length, c3 = 0; c3 < m3; c3 += 1) {
              var y3 = h3[c3];
              y3.d && (f3 = d4 ? t4(e4).diff(i4, y3.d, true) : i4.diff(e4, y3.d, true));
              var p3 = (r3.rounding || Math.round)(Math.abs(f3));
              if (s3 = f3 > 0, p3 <= y3.r || !y3.r) {
                p3 <= 1 && c3 > 0 && (y3 = h3[c3 - 1]);
                var v3 = l3[y3.l];
                u3 && (p3 = u3("" + p3)), a3 = "string" == typeof v3 ? v3.replace("%d", p3) : v3(p3, n4, y3.l, s3);
                break;
              }
            }
            if (n4) return a3;
            var M3 = s3 ? l3.future : l3.past;
            return "function" == typeof M3 ? M3(a3) : M3.replace("%s", a3);
          }, n3.to = function(r4, e4) {
            return i3(r4, e4, this, true);
          }, n3.from = function(r4, e4) {
            return i3(r4, e4, this);
          };
          var d3 = /* @__PURE__ */ __name(function(r4) {
            return r4.$u ? t4.utc() : t4();
          }, "d");
          n3.toNow = function(r4) {
            return this.to(d3(this), r4);
          }, n3.fromNow = function(r4) {
            return this.from(d3(this), r4);
          };
        };
      });
    }
  });

  // widgets/Message/Message.js
  var import_dayjs2, import_relativeTime, html52, Link, JustAnEmoji, Text, Message2, Message_default;
  var init_Message = __esm({
    "widgets/Message/Message.js"() {
      init_preact_module();
      init_hooks_module();
      init_src();
      import_dayjs2 = __toESM(require_dayjs_min());
      import_relativeTime = __toESM(require_relativeTime());
      init_anime_esm();
      init_htm_module();
      init_UserSpan();
      init_Button();
      import_dayjs2.default.extend(import_relativeTime.default);
      html52 = htm_module_default.bind(_);
      Link = /* @__PURE__ */ __name(({ url, title }) => html52`<a href=${url}>${title}</a>`, "Link");
      JustAnEmoji = /* @__PURE__ */ __name(({ emoji }) => html52`<span style="font-size: 2em;">${emoji}</span>`, "JustAnEmoji");
      Text = /* @__PURE__ */ __name(({ message }) => html52`<p>${message}</p>`, "Text");
      Message2 = /* @__PURE__ */ __name(({ slug, messageEnvelope, isMe, deleteMessage, seeDuration = 2500 }) => {
        let { url, path, query, route } = useLocation();
        const containerRef = A2(null);
        const scope3 = A2(null);
        const [seenStarted, setSeenStarted] = d2(false);
        const [seen, setSeen] = d2(messageEnvelope.seen);
        let message = messageEnvelope.message;
        let relativeTime2 = (0, import_dayjs2.default)(messageEnvelope.created_at).fromNow();
        let seenClass = seen ? "message-seen" : "message-unseen";
        const deleteMess = /* @__PURE__ */ __name(async () => {
          await deleteMessage(messageEnvelope.id);
        }, "deleteMess");
        const markAsSeen = /* @__PURE__ */ __name(async () => {
          try {
            if (seen) return;
            setSeen(true);
            await window.Data.message.markAsSeen({ slug, messageId: messageEnvelope.id });
          } catch (error) {
            console.error("Failed to mark message as seen:", error);
          }
        }, "markAsSeen");
        const markAsSeenEventually = /* @__PURE__ */ __name(async () => {
          try {
            if (seen) return;
            if (seenStarted) return;
            setSeenStarted(true);
            scope3.current = createScope({ root: containerRef }).add((self2) => {
              animate(containerRef.current, {
                opacity: [1, 0.8],
                duration: seeDuration,
                easing: "linear",
                onComplete: /* @__PURE__ */ __name(async () => {
                  await markAsSeen();
                }, "onComplete")
              });
            });
          } catch (error) {
            console.error("Failed to mark message as seen:", error);
          }
        }, "markAsSeenEventually");
        y2(() => {
          const el = containerRef.current;
          if (!el) return;
          if (seen) return;
          const observer = new IntersectionObserver((entries) => {
            entries.forEach(async (entry) => {
              if (entry.isIntersecting) {
                await markAsSeenEventually();
                observer.unobserve(entry.target);
              }
            });
          });
          observer.observe(el);
          return () => {
            observer.disconnect();
          };
        }, [messageEnvelope.id, messageEnvelope.seen, seen]);
        return html52`
    <div ref=${containerRef} class="message ${seenClass}">
        <div class="message-header">
            <div class="user-span"><${UserSpan_default} isMe=${isMe} userId=${messageEnvelope.user_id} slug=${slug} /></div>
            <div class="message-timestamp">${!seen ? html52`<span class="message-new">New!</span>` : ""} <span class='message-relativeTime'>${relativeTime2}</span></div>
        </div>
        <div class="message-content">
            ${message.Text ? html52`<${Text} message=${message.Text.message} />` : null}
            ${message.Link ? html52`<${Link} url=${message.Link.url} title=${message.Link.title} />` : null}
            ${message.JustAnEmoji ? html52`<${JustAnEmoji} emoji=${message.JustAnEmoji.emoji} />` : null}
        </div>
    </div>
    `;
      }, "Message");
      Message_default = Message2;
    }
  });

  // pages/Community/CommunityMessagesPage.js
  var CommunityMessagesPage_exports = {};
  __export(CommunityMessagesPage_exports, {
    default: () => CommunityMessagesPage_default
  });
  var html53, NullMessages, CommunityMessagesPage, CommunityMessagesPage_default;
  var init_CommunityMessagesPage = __esm({
    "pages/Community/CommunityMessagesPage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_CommunityHomePageLayout();
      init_Alert();
      init_User();
      init_Button();
      init_Message();
      html53 = htm_module_default.bind(_);
      NullMessages = /* @__PURE__ */ __name(() => html53`
    <${Alert_default} variant="null" title="Quiet. Too Quiet." message="No messages to display." />`, "NullMessages");
      CommunityMessagesPage = /* @__PURE__ */ __name(({ slug }) => {
        let [error, setError] = d2(null);
        let [session, setSession] = d2(null);
        let [messages, setMessages] = d2([]);
        let [loading, setLoading] = d2(true);
        let { url, path, query, route } = useLocation();
        y2(() => {
          const fetchMessages = /* @__PURE__ */ __name(async () => {
            try {
              let session2 = await window.Data.session.getSession({ slug });
              setSession(session2);
              let messages2 = await window.Data.message.getMessages({ slug });
              setMessages(messages2);
              window.Data.live.on("MessagesChanged", async () => {
                let messages3 = await window.Data.message.getMessages({ slug });
                console.dir(messages3);
                setMessages(messages3);
              });
            } catch (e3) {
              setError(e3.message);
            } finally {
              setLoading(false);
            }
          }, "fetchMessages");
          fetchMessages();
        }, []);
        const sendSampleMessages = /* @__PURE__ */ __name(async () => {
          try {
            let options2 = [
              "Gyre",
              "Gimble",
              "In the wabe",
              "All mimsy were the borogoves",
              "And the mome raths outgrabe",
              "Beware the Jubjub bird, and shun",
              "The frumious Bandersnatch",
              "He took his vorpal sword in hand",
              "Long time the manxome foe he sought",
              "So rested he by the Tumtum tree",
              "And stood awhile in thought",
              "And as in uffish thought he stood",
              "The Jabberwock, with eyes of flame",
              "Came whiffling through the tulgey wood",
              "And burbled as it came!"
            ];
            let randomOption = /* @__PURE__ */ __name(() => options2[Math.floor(Math.random() * options2.length)], "randomOption");
            await window.Data.message.sendMessage({ slug, userId: session.user_id, content: {
              Text: {
                message: "Hello! " + randomOption()
              }
            } });
          } catch (e3) {
            setError(e3.message);
          }
        }, "sendSampleMessages");
        const deleteMessage = /* @__PURE__ */ __name(async (messageId) => {
          try {
            await window.Data.message.deleteMessage({ slug, messageId });
            setMessages(messages.filter((m3) => m3.id !== messageId));
          } catch (e3) {
            setError(e3.message);
          }
        }, "deleteMessage");
        return html53`
    <${CommunityHomePageLayout_default} loading=${loading} slug=${slug} pageName="Messages">
        <h2>Messages</h2>

        <!--<${Button_default} onClick=${sendSampleMessages}>Send Sample Messages<//>-->

        <${Alert_default} type="error" message=${error} />

        ${messages.length > 0 ? messages.map((messageEnvelope) => html53`
            <${Message_default} key=${messageEnvelope.id} messageEnvelope=${messageEnvelope} deleteMessage=${deleteMessage} slug=${slug} isMe=${session.user_id === messageEnvelope.user_id}/>`) : html53`<${NullMessages} />`}
    <//>
    `;
      }, "CommunityMessagesPage");
      CommunityMessagesPage_default = CommunityMessagesPage;
    }
  });

  // widgets/CommunitySettings/CommunitySettings.js
  var html54, CommunitySettings, CommunitySettings_default;
  var init_CommunitySettings = __esm({
    "widgets/CommunitySettings/CommunitySettings.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_Alert();
      init_Checkbox();
      html54 = htm_module_default.bind(_);
      CommunitySettings = /* @__PURE__ */ __name(({ slug, session }) => {
        let [error, setError] = d2(null);
        let [settings, setSettings] = d2({});
        let [loading, setLoading] = d2(true);
        let { url, path, query, route } = useLocation();
        y2(() => {
          const fetchCommunitySettings = /* @__PURE__ */ __name(async () => {
            try {
              let settings2 = await window.Data.community.getCommunitySettings({ slug });
              setSettings(settings2);
            } catch (e3) {
              setError(e3.message);
            } finally {
              setLoading(false);
            }
          }, "fetchCommunitySettings");
          fetchCommunitySettings();
        }, []);
        const toggleSetting = /* @__PURE__ */ __name(async (settingKey, value) => {
          try {
            let newSettings = { ...settings, [settingKey]: value };
            let updatedSettings = await window.Data.community.setCommunitySettings({ slug, settings: newSettings });
            setSettings(updatedSettings);
          } catch (e3) {
            setError(e3.message);
          }
        }, "toggleSetting");
        return html54`
    <div class="community-settings">

        <h3>Settings</h3>

        <${Checkbox_default}
            label="Enable Viral Invitations"
            description="When this is enabled, non-admin users can generate single-use invitation codes."
            id="viral_growth_enabled"
            onChange=${(e3) => {
          toggleSetting("viral_growth_enabled", e3.target.checked);
        }}
            checked=${settings?.viral_growth_enabled || false}/>
        <br/>
        <${Checkbox_default}
            label="Lock Community"
            description="When this is enabled, new users cannot join the community at all, even if they have invitation codes."
            id="lock_community"
            onChange=${(e3) => {
          toggleSetting("lock_community", e3.target.checked);
        }}
            checked=${settings?.lock_community || false}
        />
        <br/>

        <${Alert_default} type="error" message=${error} />

    </div>

    `;
      }, "CommunitySettings");
      CommunitySettings_default = CommunitySettings;
    }
  });

  // pages/Community/CommunityAdminPage.js
  var CommunityAdminPage_exports = {};
  __export(CommunityAdminPage_exports, {
    default: () => CommunityAdminPage_default
  });
  var html55, CommunityAdminPage, CommunityAdminPage_default;
  var init_CommunityAdminPage = __esm({
    "pages/Community/CommunityAdminPage.js"() {
      init_preact_module();
      init_hooks_module();
      init_htm_module();
      init_src();
      init_CommunityHomePageLayout();
      init_CommunitySettings();
      init_Alert();
      html55 = htm_module_default.bind(_);
      CommunityAdminPage = /* @__PURE__ */ __name(({ slug }) => {
        let [error, setError] = d2(null);
        let [session, setSession] = d2(null);
        let [loading, setLoading] = d2(true);
        let { url, path, query, route } = useLocation();
        y2(() => {
          const fetchSession = /* @__PURE__ */ __name(async () => {
            try {
              console.dir(query);
              let session2 = await window.Data.session.getSession({ slug });
              setSession(session2);
              if (!session2 || !session2.is_admin) {
                route(`/community/${slug}`);
              }
            } catch (e3) {
              setError(e3.message);
            } finally {
              setLoading(false);
            }
          }, "fetchSession");
          fetchSession();
        }, []);
        return html55`
    <${CommunityHomePageLayout_default} loading=${loading} slug=${slug} pageName="Admin">
        <h2>Admin</h2>

        <${Alert_default} type="error" message=${error} />

        <${CommunitySettings_default} slug=${slug} session=${session} />

    <//>
    `;
      }, "CommunityAdminPage");
      CommunityAdminPage_default = CommunityAdminPage;
    }
  });

  // index.js
  init_preact_module();
  init_hooks_module();
  init_htm_module();
  init_src();

  // pages/Home.js
  init_preact_module();
  init_hooks_module();
  init_src();
  init_htm_module();

  // node_modules/dexie/import-wrapper.mjs
  var import_dexie = __toESM(require_dexie(), 1);
  var DexieSymbol = Symbol.for("Dexie");
  var Dexie = globalThis[DexieSymbol] || (globalThis[DexieSymbol] = import_dexie.default);
  if (import_dexie.default.semVer !== Dexie.semVer) {
    throw new Error(`Two different versions of Dexie loaded in the same app: ${import_dexie.default.semVer} and ${Dexie.semVer}`);
  }
  var {
    liveQuery,
    mergeRanges,
    rangesOverlap,
    RangeSet,
    cmp,
    Entity,
    PropModification,
    replacePrefix,
    add,
    remove
  } = Dexie;
  var import_wrapper_default = Dexie;

  // node_modules/preact/compat/dist/compat.module.js
  init_preact_module();
  init_preact_module();
  init_hooks_module();
  init_hooks_module();
  function g3(n3, t4) {
    for (var e3 in t4) n3[e3] = t4[e3];
    return n3;
  }
  __name(g3, "g");
  function E2(n3, t4) {
    for (var e3 in n3) if ("__source" !== e3 && !(e3 in t4)) return true;
    for (var r3 in t4) if ("__source" !== r3 && n3[r3] !== t4[r3]) return true;
    return false;
  }
  __name(E2, "E");
  function C3(n3, t4) {
    var e3 = t4(), r3 = d2({ t: { __: e3, u: t4 } }), u3 = r3[0].t, o3 = r3[1];
    return _2(function() {
      u3.__ = e3, u3.u = t4, x3(u3) && o3({ t: u3 });
    }, [n3, e3, t4]), y2(function() {
      return x3(u3) && o3({ t: u3 }), n3(function() {
        x3(u3) && o3({ t: u3 });
      });
    }, [n3]), e3;
  }
  __name(C3, "C");
  function x3(n3) {
    var t4, e3, r3 = n3.u, u3 = n3.__;
    try {
      var o3 = r3();
      return !((t4 = u3) === (e3 = o3) && (0 !== t4 || 1 / t4 == 1 / e3) || t4 != t4 && e3 != e3);
    } catch (n4) {
      return true;
    }
  }
  __name(x3, "x");
  function R(n3) {
    n3();
  }
  __name(R, "R");
  function w3(n3) {
    return n3;
  }
  __name(w3, "w");
  function k3() {
    return [false, R];
  }
  __name(k3, "k");
  var I2 = _2;
  function N2(n3, t4) {
    this.props = n3, this.context = t4;
  }
  __name(N2, "N");
  function M2(n3, e3) {
    function r3(n4) {
      var t4 = this.props.ref, r4 = t4 == n4.ref;
      return !r4 && t4 && (t4.call ? t4(null) : t4.current = null), e3 ? !e3(this.props, n4) || !r4 : E2(this.props, n4);
    }
    __name(r3, "r");
    function u3(e4) {
      return this.shouldComponentUpdate = r3, _(n3, e4);
    }
    __name(u3, "u");
    return u3.displayName = "Memo(" + (n3.displayName || n3.name) + ")", u3.prototype.isReactComponent = true, u3.__f = true, u3;
  }
  __name(M2, "M");
  (N2.prototype = new x()).isPureReactComponent = true, N2.prototype.shouldComponentUpdate = function(n3, t4) {
    return E2(this.props, n3) || E2(this.state, t4);
  };
  var T3 = l.__b;
  l.__b = function(n3) {
    n3.type && n3.type.__f && n3.ref && (n3.props.ref = n3.ref, n3.ref = null), T3 && T3(n3);
  };
  var A3 = "undefined" != typeof Symbol && Symbol.for && Symbol.for("react.forward_ref") || 3911;
  function D3(n3) {
    function t4(t5) {
      var e3 = g3({}, t5);
      return delete e3.ref, n3(e3, t5.ref || null);
    }
    __name(t4, "t");
    return t4.$$typeof = A3, t4.render = t4, t4.prototype.isReactComponent = t4.__f = true, t4.displayName = "ForwardRef(" + (n3.displayName || n3.name) + ")", t4;
  }
  __name(D3, "D");
  var L2 = /* @__PURE__ */ __name(function(n3, t4) {
    return null == n3 ? null : H(H(n3).map(t4));
  }, "L");
  var O2 = { map: L2, forEach: L2, count: /* @__PURE__ */ __name(function(n3) {
    return n3 ? H(n3).length : 0;
  }, "count"), only: /* @__PURE__ */ __name(function(n3) {
    var t4 = H(n3);
    if (1 !== t4.length) throw "Children.only";
    return t4[0];
  }, "only"), toArray: H };
  var F3 = l.__e;
  l.__e = function(n3, t4, e3, r3) {
    if (n3.then) {
      for (var u3, o3 = t4; o3 = o3.__; ) if ((u3 = o3.__c) && u3.__c) return null == t4.__e && (t4.__e = e3.__e, t4.__k = e3.__k), u3.__c(n3, t4);
    }
    F3(n3, t4, e3, r3);
  };
  var U = l.unmount;
  function V2(n3, t4, e3) {
    return n3 && (n3.__c && n3.__c.__H && (n3.__c.__H.__.forEach(function(n4) {
      "function" == typeof n4.__c && n4.__c();
    }), n3.__c.__H = null), null != (n3 = g3({}, n3)).__c && (n3.__c.__P === e3 && (n3.__c.__P = t4), n3.__c = null), n3.__k = n3.__k && n3.__k.map(function(n4) {
      return V2(n4, t4, e3);
    })), n3;
  }
  __name(V2, "V");
  function W(n3, t4, e3) {
    return n3 && e3 && (n3.__v = null, n3.__k = n3.__k && n3.__k.map(function(n4) {
      return W(n4, t4, e3);
    }), n3.__c && n3.__c.__P === t4 && (n3.__e && e3.appendChild(n3.__e), n3.__c.__e = true, n3.__c.__P = e3)), n3;
  }
  __name(W, "W");
  function P3() {
    this.__u = 0, this.o = null, this.__b = null;
  }
  __name(P3, "P");
  function j3(n3) {
    var t4 = n3.__.__c;
    return t4 && t4.__a && t4.__a(n3);
  }
  __name(j3, "j");
  function z3(n3) {
    var e3, r3, u3;
    function o3(o4) {
      if (e3 || (e3 = n3()).then(function(n4) {
        r3 = n4.default || n4;
      }, function(n4) {
        u3 = n4;
      }), u3) throw u3;
      if (!r3) throw e3;
      return _(r3, o4);
    }
    __name(o3, "o");
    return o3.displayName = "Lazy", o3.__f = true, o3;
  }
  __name(z3, "z");
  function B3() {
    this.i = null, this.l = null;
  }
  __name(B3, "B");
  l.unmount = function(n3) {
    var t4 = n3.__c;
    t4 && t4.__R && t4.__R(), t4 && 32 & n3.__u && (n3.type = null), U && U(n3);
  }, (P3.prototype = new x()).__c = function(n3, t4) {
    var e3 = t4.__c, r3 = this;
    null == r3.o && (r3.o = []), r3.o.push(e3);
    var u3 = j3(r3.__v), o3 = false, i3 = /* @__PURE__ */ __name(function() {
      o3 || (o3 = true, e3.__R = null, u3 ? u3(c3) : c3());
    }, "i");
    e3.__R = i3;
    var c3 = /* @__PURE__ */ __name(function() {
      if (!--r3.__u) {
        if (r3.state.__a) {
          var n4 = r3.state.__a;
          r3.__v.__k[0] = W(n4, n4.__c.__P, n4.__c.__O);
        }
        var t5;
        for (r3.setState({ __a: r3.__b = null }); t5 = r3.o.pop(); ) t5.forceUpdate();
      }
    }, "c");
    r3.__u++ || 32 & t4.__u || r3.setState({ __a: r3.__b = r3.__v.__k[0] }), n3.then(i3, i3);
  }, P3.prototype.componentWillUnmount = function() {
    this.o = [];
  }, P3.prototype.render = function(n3, e3) {
    if (this.__b) {
      if (this.__v.__k) {
        var r3 = document.createElement("div"), o3 = this.__v.__k[0].__c;
        this.__v.__k[0] = V2(this.__b, r3, o3.__O = o3.__P);
      }
      this.__b = null;
    }
    var i3 = e3.__a && _(k, null, n3.fallback);
    return i3 && (i3.__u &= -33), [_(k, null, e3.__a ? null : n3.children), i3];
  };
  var H2 = /* @__PURE__ */ __name(function(n3, t4, e3) {
    if (++e3[1] === e3[0] && n3.l.delete(t4), n3.props.revealOrder && ("t" !== n3.props.revealOrder[0] || !n3.l.size)) for (e3 = n3.i; e3; ) {
      for (; e3.length > 3; ) e3.pop()();
      if (e3[1] < e3[0]) break;
      n3.i = e3 = e3[2];
    }
  }, "H");
  function Z(n3) {
    return this.getChildContext = function() {
      return n3.context;
    }, n3.children;
  }
  __name(Z, "Z");
  function Y(n3) {
    var e3 = this, r3 = n3.h;
    e3.componentWillUnmount = function() {
      D(null, e3.v), e3.v = null, e3.h = null;
    }, e3.h && e3.h !== r3 && e3.componentWillUnmount(), e3.v || (e3.h = r3, e3.v = { nodeType: 1, parentNode: r3, childNodes: [], contains: /* @__PURE__ */ __name(function() {
      return true;
    }, "contains"), appendChild: /* @__PURE__ */ __name(function(n4) {
      this.childNodes.push(n4), e3.h.appendChild(n4);
    }, "appendChild"), insertBefore: /* @__PURE__ */ __name(function(n4, t4) {
      this.childNodes.push(n4), e3.h.insertBefore(n4, t4);
    }, "insertBefore"), removeChild: /* @__PURE__ */ __name(function(n4) {
      this.childNodes.splice(this.childNodes.indexOf(n4) >>> 1, 1), e3.h.removeChild(n4);
    }, "removeChild") }), D(_(Z, { context: e3.context }, n3.__v), e3.v);
  }
  __name(Y, "Y");
  function $2(n3, e3) {
    var r3 = _(Y, { __v: n3, h: e3 });
    return r3.containerInfo = e3, r3;
  }
  __name($2, "$");
  (B3.prototype = new x()).__a = function(n3) {
    var t4 = this, e3 = j3(t4.__v), r3 = t4.l.get(n3);
    return r3[0]++, function(u3) {
      var o3 = /* @__PURE__ */ __name(function() {
        t4.props.revealOrder ? (r3.push(u3), H2(t4, n3, r3)) : u3();
      }, "o");
      e3 ? e3(o3) : o3();
    };
  }, B3.prototype.render = function(n3) {
    this.i = null, this.l = /* @__PURE__ */ new Map();
    var t4 = H(n3.children);
    n3.revealOrder && "b" === n3.revealOrder[0] && t4.reverse();
    for (var e3 = t4.length; e3--; ) this.l.set(t4[e3], this.i = [1, 0, this.i]);
    return n3.children;
  }, B3.prototype.componentDidUpdate = B3.prototype.componentDidMount = function() {
    var n3 = this;
    this.l.forEach(function(t4, e3) {
      H2(n3, e3, t4);
    });
  };
  var q3 = "undefined" != typeof Symbol && Symbol.for && Symbol.for("react.element") || 60103;
  var G2 = /^(?:accent|alignment|arabic|baseline|cap|clip(?!PathU)|color|dominant|fill|flood|font|glyph(?!R)|horiz|image(!S)|letter|lighting|marker(?!H|W|U)|overline|paint|pointer|shape|stop|strikethrough|stroke|text(?!L)|transform|underline|unicode|units|v|vector|vert|word|writing|x(?!C))[A-Z]/;
  var J2 = /^on(Ani|Tra|Tou|BeforeInp|Compo)/;
  var K = /[A-Z0-9]/g;
  var Q = "undefined" != typeof document;
  var X = /* @__PURE__ */ __name(function(n3) {
    return ("undefined" != typeof Symbol && "symbol" == typeof Symbol() ? /fil|che|rad/ : /fil|che|ra/).test(n3);
  }, "X");
  function nn(n3, t4, e3) {
    return null == t4.__k && (t4.textContent = ""), D(n3, t4), "function" == typeof e3 && e3(), n3 ? n3.__c : null;
  }
  __name(nn, "nn");
  function tn(n3, t4, e3) {
    return E(n3, t4), "function" == typeof e3 && e3(), n3 ? n3.__c : null;
  }
  __name(tn, "tn");
  x.prototype.isReactComponent = {}, ["componentWillMount", "componentWillReceiveProps", "componentWillUpdate"].forEach(function(t4) {
    Object.defineProperty(x.prototype, t4, { configurable: true, get: /* @__PURE__ */ __name(function() {
      return this["UNSAFE_" + t4];
    }, "get"), set: /* @__PURE__ */ __name(function(n3) {
      Object.defineProperty(this, t4, { configurable: true, writable: true, value: n3 });
    }, "set") });
  });
  var en = l.event;
  function rn() {
  }
  __name(rn, "rn");
  function un() {
    return this.cancelBubble;
  }
  __name(un, "un");
  function on() {
    return this.defaultPrevented;
  }
  __name(on, "on");
  l.event = function(n3) {
    return en && (n3 = en(n3)), n3.persist = rn, n3.isPropagationStopped = un, n3.isDefaultPrevented = on, n3.nativeEvent = n3;
  };
  var cn;
  var ln = { enumerable: false, configurable: true, get: /* @__PURE__ */ __name(function() {
    return this.class;
  }, "get") };
  var fn = l.vnode;
  l.vnode = function(n3) {
    "string" == typeof n3.type && function(n4) {
      var t4 = n4.props, e3 = n4.type, u3 = {}, o3 = -1 === e3.indexOf("-");
      for (var i3 in t4) {
        var c3 = t4[i3];
        if (!("value" === i3 && "defaultValue" in t4 && null == c3 || Q && "children" === i3 && "noscript" === e3 || "class" === i3 || "className" === i3)) {
          var l3 = i3.toLowerCase();
          "defaultValue" === i3 && "value" in t4 && null == t4.value ? i3 = "value" : "download" === i3 && true === c3 ? c3 = "" : "translate" === l3 && "no" === c3 ? c3 = false : "o" === l3[0] && "n" === l3[1] ? "ondoubleclick" === l3 ? i3 = "ondblclick" : "onchange" !== l3 || "input" !== e3 && "textarea" !== e3 || X(t4.type) ? "onfocus" === l3 ? i3 = "onfocusin" : "onblur" === l3 ? i3 = "onfocusout" : J2.test(i3) && (i3 = l3) : l3 = i3 = "oninput" : o3 && G2.test(i3) ? i3 = i3.replace(K, "-$&").toLowerCase() : null === c3 && (c3 = void 0), "oninput" === l3 && u3[i3 = l3] && (i3 = "oninputCapture"), u3[i3] = c3;
        }
      }
      "select" == e3 && u3.multiple && Array.isArray(u3.value) && (u3.value = H(t4.children).forEach(function(n5) {
        n5.props.selected = -1 != u3.value.indexOf(n5.props.value);
      })), "select" == e3 && null != u3.defaultValue && (u3.value = H(t4.children).forEach(function(n5) {
        n5.props.selected = u3.multiple ? -1 != u3.defaultValue.indexOf(n5.props.value) : u3.defaultValue == n5.props.value;
      })), t4.class && !t4.className ? (u3.class = t4.class, Object.defineProperty(u3, "className", ln)) : (t4.className && !t4.class || t4.class && t4.className) && (u3.class = u3.className = t4.className), n4.props = u3;
    }(n3), n3.$$typeof = q3, fn && fn(n3);
  };
  var an = l.__r;
  l.__r = function(n3) {
    an && an(n3), cn = n3.__c;
  };
  var sn = l.diffed;
  l.diffed = function(n3) {
    sn && sn(n3);
    var t4 = n3.props, e3 = n3.__e;
    null != e3 && "textarea" === n3.type && "value" in t4 && t4.value !== e3.value && (e3.value = null == t4.value ? "" : t4.value), cn = null;
  };
  var hn = { ReactCurrentDispatcher: { current: { readContext: /* @__PURE__ */ __name(function(n3) {
    return cn.__n[n3.__c].props.value;
  }, "readContext"), useCallback: q2, useContext: x2, useDebugValue: P2, useDeferredValue: w3, useEffect: y2, useId: g2, useImperativeHandle: F2, useInsertionEffect: I2, useLayoutEffect: _2, useMemo: T2, useReducer: h2, useRef: A2, useState: d2, useSyncExternalStore: C3, useTransition: k3 } } };
  function dn(n3) {
    return _.bind(null, n3);
  }
  __name(dn, "dn");
  function pn(n3) {
    return !!n3 && n3.$$typeof === q3;
  }
  __name(pn, "pn");
  function mn(n3) {
    return pn(n3) && n3.type === k;
  }
  __name(mn, "mn");
  function yn(n3) {
    return !!n3 && !!n3.displayName && ("string" == typeof n3.displayName || n3.displayName instanceof String) && n3.displayName.startsWith("Memo(");
  }
  __name(yn, "yn");
  function _n(n3) {
    return pn(n3) ? G.apply(null, arguments) : n3;
  }
  __name(_n, "_n");
  function bn(n3) {
    return !!n3.__k && (D(null, n3), true);
  }
  __name(bn, "bn");
  function Sn(n3) {
    return n3 && (n3.base || 1 === n3.nodeType && n3) || null;
  }
  __name(Sn, "Sn");
  var gn = /* @__PURE__ */ __name(function(n3, t4) {
    return n3(t4);
  }, "gn");
  var En = /* @__PURE__ */ __name(function(n3, t4) {
    return n3(t4);
  }, "En");
  var Cn = k;
  var xn = pn;
  var Rn = { useState: d2, useId: g2, useReducer: h2, useEffect: y2, useLayoutEffect: _2, useInsertionEffect: I2, useTransition: k3, useDeferredValue: w3, useSyncExternalStore: C3, startTransition: R, useRef: A2, useImperativeHandle: F2, useMemo: T2, useCallback: q2, useContext: x2, useDebugValue: P2, version: "18.3.1", Children: O2, render: nn, hydrate: tn, unmountComponentAtNode: bn, createPortal: $2, createElement: _, createContext: J, createFactory: dn, cloneElement: _n, createRef: b, Fragment: k, isValidElement: pn, isElement: xn, isFragment: mn, isMemo: yn, findDOMNode: Sn, Component: x, PureComponent: N2, memo: M2, forwardRef: D3, flushSync: En, unstable_batchedUpdates: gn, StrictMode: Cn, Suspense: P3, SuspenseList: B3, lazy: z3, __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: hn };

  // node_modules/dexie-react-hooks/dist/dexie-react-hooks.mjs
  function useObservable(observableFactory, arg2, arg3) {
    var deps;
    var defaultResult;
    if (typeof observableFactory === "function") {
      deps = arg2 || [];
      defaultResult = arg3;
    } else {
      deps = [];
      defaultResult = arg2;
    }
    var monitor = Rn.useRef({
      hasResult: false,
      result: defaultResult,
      error: null
    });
    var _a = Rn.useReducer(function(x4) {
      return x4 + 1;
    }, 0);
    _a[0];
    var triggerUpdate = _a[1];
    var observable = Rn.useMemo(function() {
      var observable2 = typeof observableFactory === "function" ? observableFactory() : observableFactory;
      if (!observable2 || typeof observable2.subscribe !== "function") {
        if (observableFactory === observable2) {
          throw new TypeError("Given argument to useObservable() was neither a valid observable nor a function.");
        } else {
          throw new TypeError("Observable factory given to useObservable() did not return a valid observable.");
        }
      }
      if (!monitor.current.hasResult && typeof window !== "undefined") {
        if (typeof observable2.hasValue !== "function" || observable2.hasValue()) {
          if (typeof observable2.getValue === "function") {
            monitor.current.result = observable2.getValue();
            monitor.current.hasResult = true;
          } else {
            var subscription = observable2.subscribe(function(val) {
              monitor.current.result = val;
              monitor.current.hasResult = true;
            });
            if (typeof subscription === "function") {
              subscription();
            } else {
              subscription.unsubscribe();
            }
          }
        }
      }
      return observable2;
    }, deps);
    Rn.useDebugValue(monitor.current.result);
    Rn.useEffect(function() {
      var subscription = observable.subscribe(function(val) {
        var current = monitor.current;
        if (current.error !== null || current.result !== val) {
          current.error = null;
          current.result = val;
          current.hasResult = true;
          triggerUpdate();
        }
      }, function(err) {
        var current = monitor.current;
        if (current.error !== err) {
          current.error = err;
          triggerUpdate();
        }
      });
      return typeof subscription === "function" ? subscription : subscription.unsubscribe.bind(subscription);
    }, deps);
    if (monitor.current.error)
      throw monitor.current.error;
    return monitor.current.result;
  }
  __name(useObservable, "useObservable");
  function useLiveQuery(querier, deps, defaultResult) {
    return useObservable(function() {
      return liveQuery(querier);
    }, deps || [], defaultResult);
  }
  __name(useLiveQuery, "useLiveQuery");

  // pages/Home.js
  init_BasicPageLayout();
  init_Button();
  init_Flexstack();
  init_ButtonFrame();
  var html6 = htm_module_default.bind(_);
  var Home = /* @__PURE__ */ __name(() => {
    let { url, path, query, route } = useLocation();
    y2(() => {
      document.title = "Home";
    }, []);
    const activeCommunities = useLiveQuery(async () => {
      try {
        let communities = await window.Data.community.getActiveCommunities({ n: 5 });
        return communities;
      } catch (err) {
        console.error("Error fetching active communities:", err);
        return [];
      }
    }, []);
    let create = /* @__PURE__ */ __name(() => {
      route("/home/create");
    }, "create");
    let find = /* @__PURE__ */ __name(() => {
      route("/home/find");
    }, "find");
    let about = /* @__PURE__ */ __name(() => {
      route("/home/about");
    }, "about");
    return html6`
    <${BasicPageLayout_default} id="home" title="Home" fullyTransparent>
        <div>
            <div class="home-cloud home-cloud-1">
                <div>
                    Already part of a Community? Find it here to log-in!
                </div>
                <div>
                    <${Button_default} label="Find" onClick=${find}>Find Community</${Button_default}>
                </div>
            </div>
            <div class="home-cloud home-cloud-2">
                <div>
                    A Community is a group of users working together. Create one to get started!
                </div>
                <div>
                    <${Button_default} label="Create" onClick=${create}>Create Community</${Button_default}>
                </div>
            </div>

            <div class="home-cloud home-cloud-3">
                <div>
                    What is groovelet.com?
                </div>
                <div>
                    <${Button_default} label="About" onClick=${about}>??</${Button_default}>
                </div>
            </div>
        </div>
    <//>
    `;
  }, "Home");
  var Home_default = Home;

  // pages/LoadingPage.js
  init_preact_module();
  init_hooks_module();
  init_htm_module();
  init_BasicPageLayout();
  var html7 = htm_module_default.bind(_);
  var LoadingPage = /* @__PURE__ */ __name(() => {
    return html7`
    <${BasicPageLayout_default} loading=${true} title="Loading...">
        You'll never see this!
    <//>`;
  }, "LoadingPage");
  var LoadingPage_default = LoadingPage;

  // http/fetch.js
  function makeFetchHappen({ endpoint, options: options2 = {} } = {}) {
    const fitch = /* @__PURE__ */ __name(async (...args) => {
      let originalTarget = args[0];
      let slug = false;
      if (originalTarget.startsWith("api/community/")) {
        let parts = originalTarget.split("/");
        if (parts.length > 3) {
          slug = parts[2];
        }
      }
      args[0] = `${endpoint}/${originalTarget}`;
      if (args[1] && args[1].body) {
        if (!args[1].headers) {
          args[1].headers = {};
        }
        args[1].headers["Content-Type"] = "application/json";
      }
      if (options2.network_simulation) {
        let possibleDelays = [10, 50, 50, 50, 50, 50, 100, 200, 500, 1e3];
        let delay = possibleDelays[Math.floor(Math.random() * possibleDelays.length)];
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      let resp = await fetch(...args);
      if (resp.status == 422) {
        let text = await resp.text();
        console.error(text);
        throw new Error(text);
      }
      if (resp.status == 401) {
        console.error("Unauthorized request, logging out user");
        await fetch(`${endpoint}/api/community/${slug}/logout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          }
        });
        throw new Error("Login session expired, please try again");
      }
      if (resp.status == 404 && !options2.errorOn404) {
        return null;
      }
      let json = await resp.json();
      if (resp.status != 200) {
        console.error(json.message);
        throw new Error(json.message);
      }
      return json;
    }, "fitch");
    return fitch;
  }
  __name(makeFetchHappen, "makeFetchHappen");

  // model/Community.js
  var Community = class {
    static {
      __name(this, "Community");
    }
    // every Model has a schema method that returns the schema for the model
    schema() {
      return {
        active_communities: "++community_slug,last_access",
        community_names: "++community_slug,community_name"
      };
    }
    // instantiate is called when the Data system is booted
    instantiate({ db, models, fetch: fetch2, fetch_no404 }) {
      this.db = db;
      this.models = models;
      this.fetch = fetch2;
      this.fetch_no404 = fetch_no404;
    }
    // -- ACTIVE COMMUNITIES --
    // These are communities that the user is currently logged into or has recently accessed
    // (users are likely to return to the same communities frequently, so making them search every time is annoying)
    async addActiveCommunity({ community_slug }) {
      console.dir(`Adding active community: ${community_slug}`);
      await this.db.active_communities.put({ community_slug, last_access: /* @__PURE__ */ new Date() });
    }
    async removeActiveCommunity({ community_slug }) {
      await this.db.active_communities.delete(community_slug);
    }
    async getActiveCommunities({ n: n3 }) {
      return await this.db.active_communities.orderBy("last_access").reverse().limit(n3).toArray();
    }
    // -- CREATING & LISTING COMMUNITIES --
    async createCommunity({ community_name, name, email, phone_number, password, tos }) {
      return this.fetch("api/community", {
        method: "POST",
        body: JSON.stringify({ community_name, name, email, phone_number, password, tos })
      });
    }
    async listCommunities({ prefix, n: n3 = 5, offset = 0 }) {
      console.warn("Listing communities with prefix", prefix, "n", n3, "offset", offset);
      let communities = await this.fetch(`api/community?prefix=${prefix}&n=${n3}&offset=${offset}`);
      if (communities && communities.length > 0) {
        for (let community of communities) {
          try {
            await this.db.community_names.put({
              community_slug: community.community_slug,
              community_name: community.community_name
            });
          } catch (err) {
            console.error("Error adding community to local database", err);
          }
        }
      }
      return communities;
    }
    async getCommunity({ slug }) {
      let community = await this.db.community_names.get(slug);
      if (community) {
        return community;
      }
      community = await this.fetch(`api/community/${slug}`);
      if (community) {
        await this.db.community_names.add({
          community_slug: community.community_slug,
          community_name: community.community_name
        });
      }
      return community;
    }
    async getCommunitySettings({ slug }) {
      return this.fetch(`api/community/${slug}/settings`);
    }
    async setCommunitySettings({ slug, settings }) {
      return this.fetch(`api/community/${slug}/settings`, {
        method: "POST",
        body: JSON.stringify(settings)
      });
    }
  };

  // model/Verify.js
  var Verify = class {
    static {
      __name(this, "Verify");
    }
    // every Model has a schema method that returns the schema for the model
    schema() {
      return {};
    }
    // instantiate is called when the Data system is booted
    instantiate({ db, models, fetch: fetch2, fetch_no404 }) {
      this.db = db;
      this.models = models;
      this.fetch = fetch2;
      this.fetch_no404 = fetch_no404;
    }
    async sendSmsVerificationCode({ slug }) {
      return this.fetch(`api/community/${slug}/auth/verify/sms`, {
        method: "POST"
      });
    }
    async verifySmsVerificationCode({ slug, user_id, code }) {
      return this.fetch(`api/community/${slug}/auth/verify/sms/complete`, {
        method: "POST",
        body: JSON.stringify({
          user_id,
          code
        })
      });
    }
    async sendEmailVerificationCode({ slug }) {
      return this.fetch(`api/community/${slug}/auth/verify/email`, {
        method: "POST"
      });
    }
    async verifyEmailVerificationCode({ slug, user_id, code }) {
      return this.fetch(`api/community/${slug}/auth/verify/email/complete`, {
        method: "POST",
        body: JSON.stringify({
          user_id,
          code
        })
      });
    }
  };

  // model/Session.js
  var Session = class {
    static {
      __name(this, "Session");
    }
    // every Model has a schema method that returns the schema for the model
    schema() {
      return {};
    }
    // instantiate is called when the Data system is booted
    instantiate({ db, models, fetch: fetch2, fetch_no404 }) {
      this.db = db;
      this.models = models;
      this.fetch = fetch2;
      this.fetch_no404 = fetch_no404;
      this.local = {};
    }
    /* If we already HAVE a session, this will just return it. */
    async getSession({ slug, reload, touch }) {
      if (!reload && this.local[slug] && this.local[slug].session) {
        if (this.local[slug].session instanceof Error) {
          throw this.local[slug].session;
        }
        return this.local[slug].session;
      }
      let touchQuery = "";
      if (touch) {
        touchQuery = "?touch=true";
      }
      let resp;
      try {
        resp = await this.fetch(`api/community/${slug}/auth${touchQuery}`);
      } catch (e3) {
        if (!e3.message) {
          throw e3;
        }
        let message = e3.message.toLowerCase();
        if (message.includes("no session") || message.includes("not valid")) {
          this.local[slug] = this.local[slug] || {};
          this.local[slug].session = e3;
        }
        throw e3;
      }
      this.local[slug] = this.local[slug] || {};
      this.local[slug].session = resp;
      return resp;
    }
    async logout({ slug }) {
      delete this.local[slug];
      return this.fetch(`api/community/${slug}/logout`);
    }
    async login({ slug, email, phone_number, password }) {
      delete this.local[slug];
      if (!password) {
        throw new Error("Login requires a password");
      }
      return this.fetch_no404(`api/community/${slug}/login`, {
        method: "POST",
        body: JSON.stringify({
          email,
          phone_number,
          password
        })
      });
    }
    async loginToken({ slug, email, phone_number }) {
      let query = {};
      if (email) {
        query.email = email;
      }
      if (phone_number) {
        query.phone_number = phone_number;
      }
      return this.fetch_no404(`api/community/${slug}/login/token`, {
        method: "POST",
        body: JSON.stringify(query)
      });
    }
    async loginTokenComplete({ slug, token, user_id }) {
      delete this.local[slug];
      return this.fetch_no404(`api/community/${slug}/login/token/complete?code=${token}&user_id=${user_id}`, {
        method: "POST",
        body: JSON.stringify({})
      });
    }
  };

  // model/User.js
  var User = class {
    static {
      __name(this, "User");
    }
    // every Model has a schema method that returns the schema for the model
    schema() {
      return {};
    }
    // instantiate is called when the Data system is booted
    instantiate({ db, models, fetch: fetch2, fetch_no404 }) {
      this.db = db;
      this.models = models;
      this.fetch = fetch2;
      this.fetch_no404 = fetch_no404;
      this.user_cache = {};
      this.user_promise_cache = {};
      this.user_cache_by_slug = {};
      this.user_promise_cache_by_slug = {};
    }
    async createUser({ slug, user, invite_code }) {
      let { name, email, phone_number, password, tos } = user;
      return this.fetch(`api/community/${slug}/invite/${invite_code}`, {
        method: "POST",
        body: JSON.stringify({ name, email, phone_number, password, tos })
      });
    }
    async listUsers({ slug }) {
      return this.fetch(`api/community/${slug}/users`);
    }
    clearUserCache() {
      this.user_cache = {};
      this.user_promise_cache = {};
      this.user_cache_by_slug = {};
    }
    // this cache pattern allows us not just to cache the user data after it is fetched,
    //  but also to have multiple simultaneous requests for the same user all use the same network call
    //  rather than triggering multiple network calls for the same user
    // (this is useful for when multiple components on the page need the same user data)
    async getUser({ slug, userId }) {
      if (this.user_cache[userId]) {
        return this.user_cache[userId];
      }
      if (this.user_promise_cache[userId]) {
        return this.user_promise_cache[userId];
      }
      let user_promise = this.fetch(`api/community/${slug}/user/${userId}`);
      this.user_promise_cache[userId] = user_promise;
      let user = await user_promise;
      delete this.user_promise_cache[userId];
      if (user) {
        this.user_cache[userId] = user;
        this.user_cache_by_slug[user.slug] = user;
        return user;
      }
    }
    async getUserBySlug({ slug, userSlug }) {
      if (this.user_cache_by_slug[userSlug]) {
        return this.user_cache_by_slug[userSlug];
      }
      if (this.user_promise_cache_by_slug[userSlug]) {
        return this.user_promise_cache_by_slug[userSlug];
      }
      let user_promise = this.fetch(`api/community/${slug}/slug/${userSlug}`);
      this.user_promise_cache_by_slug[userSlug] = user_promise;
      let user = await user_promise;
      delete this.user_promise_cache_by_slug[userSlug];
      if (user) {
        this.user_cache[user.id] = user;
        this.user_cache_by_slug[userSlug] = user;
        return user;
      }
    }
    async changeName({ slug, name }) {
      this.clearUserCache();
      return this.fetch(`api/community/${slug}/auth/change/name`, {
        method: "POST",
        body: JSON.stringify(name)
      });
    }
    async changePassword({ slug, password }) {
      this.clearUserCache();
      return this.fetch(`api/community/${slug}/auth/change/password`, {
        method: "POST",
        body: JSON.stringify(password)
      });
    }
    async changeEmail({ slug, email }) {
      this.clearUserCache();
      return this.fetch(`api/community/${slug}/auth/change/email`, {
        method: "POST",
        body: JSON.stringify(email)
      });
    }
    async changePhone({ slug, phone_number }) {
      this.clearUserCache();
      return this.fetch(`api/community/${slug}/auth/change/phone`, {
        method: "POST",
        body: JSON.stringify(phone_number)
      });
    }
    async lockUser({ slug, user_id }) {
      this.clearUserCache();
      return this.fetch(`api/community/${slug}/user/${user_id}/lock`, {
        method: "POST"
      });
    }
    async unlockUser({ slug, user_id }) {
      this.clearUserCache();
      return this.fetch(`api/community/${slug}/user/${user_id}/unlock`, {
        method: "POST"
      });
    }
    async deleteUser({ slug, user_id }) {
      this.clearUserCache();
      return this.fetch(`api/community/${slug}/user/${user_id}`, {
        method: "DELETE"
      });
    }
    async adminUser({ slug, user_id }) {
      this.clearUserCache();
      return this.fetch(`api/community/${slug}/user/${user_id}/admin`, {
        method: "POST"
      });
    }
    async unadminUser({ slug, user_id }) {
      this.clearUserCache();
      return this.fetch(`api/community/${slug}/user/${user_id}/unadmin`, {
        method: "POST"
      });
    }
  };

  // model/InviteCode.js
  var InviteCode = class {
    static {
      __name(this, "InviteCode");
    }
    // every Model has a schema method that returns the schema for the model
    schema() {
      return {};
    }
    // instantiate is called when the Data system is booted
    instantiate({ db, models, fetch: fetch2, fetch_no404 }) {
      this.db = db;
      this.models = models;
      this.fetch = fetch2;
      this.fetch_no404 = fetch_no404;
    }
    async getInviteCodes({ slug }) {
      return this.fetch(`api/community/${slug}/invite`);
    }
    async createInviteCode({ slug, use_type }) {
      console.warn("hi");
      if (use_type !== "once" && use_type !== "unlimited") {
        throw new Error("Invalid use_type");
      }
      let resp = await this.fetch(`api/community/${slug}/invite`, {
        method: "POST",
        body: JSON.stringify({
          use_type
        })
      });
      return {
        invite_code: resp.invite_code,
        created_at: /* @__PURE__ */ new Date(),
        use_type
      };
    }
    async deleteInviteCode({ slug, code }) {
      return this.fetch(`api/community/${slug}/invite/${code}`, {
        method: "DELETE"
      });
    }
  };

  // model/Audit.js
  var Audit = class {
    static {
      __name(this, "Audit");
    }
    // every Model has a schema method that returns the schema for the model
    schema() {
      return {};
    }
    // instantiate is called when the Data system is booted
    instantiate({ db, models, fetch: fetch2, fetch_no404 }) {
      this.db = db;
      this.models = models;
      this.fetch = fetch2;
      this.fetch_no404 = fetch_no404;
    }
    async getAudits({ slug, user_id, system, action, triggered_by, ip, forwarded_for, fingerprint, n: n3 = 100, offset = 0 }) {
      const params = new URLSearchParams({
        ...user_id && { user_id },
        ...system && { system },
        ...action && { action },
        ...triggered_by && { triggered_by },
        ...ip && { ip },
        ...forwarded_for && { forwarded_for },
        ...fingerprint && { fingerprint },
        n: n3,
        offset
      });
      return this.fetch(`api/community/${slug}/audit?${params.toString()}`);
    }
  };

  // model/Message.js
  var Message = class {
    static {
      __name(this, "Message");
    }
    // every Model has a schema method that returns the schema for the model (if they save local data)
    schema() {
      return {};
    }
    // instantiate is called when the Data system is booted
    instantiate({ db, models, fetch: fetch2, fetch_no404 }) {
      this.db = db;
      this.models = models;
      this.fetch = fetch2;
      this.fetch_no404 = fetch_no404;
    }
    async getMessages({ slug, n: n3 = 100, offset = 0 }) {
      return this.fetch(`api/community/${slug}/messages?n=${n3}&offset=${offset}`);
    }
    async getMessagesAfter({ slug, timestamp_micros, n: n3 = 100, offset = 0 }) {
      return this.fetch(`api/community/${slug}/messages/after/${timestamp_micros}?n=${n3}&offset=${offset}`);
    }
    async sendMessage({ slug, userId, content }) {
      return this.fetch(`api/community/${slug}/messages`, {
        method: "POST",
        body: JSON.stringify({
          target_user_id: userId,
          message: content
        })
      });
    }
    async markAsSeen({ slug, messageId }) {
      return this.fetch_no404(`api/community/${slug}/messages/${messageId}/seen`, {
        method: "POST"
      });
    }
    async deleteMessage({ slug, messageId }) {
      return this.fetch(`api/community/${slug}/messages/${messageId}`, {
        method: "DELETE"
      });
    }
    async getUnseenMessageCount({ slug }) {
      return this.fetch(`api/community/${slug}/messages/count`);
    }
  };

  // model/Live.js
  var Live = class {
    static {
      __name(this, "Live");
    }
    // every Model has a schema method that returns the schema for the model
    schema() {
      return {};
    }
    // instantiate is called when the Data system is booted
    instantiate({ db, models, fetch: fetch2, fetch_no404, endpoint }) {
      this.db = db;
      this.models = models;
      this.fetch = fetch2;
      this.fetch_no404 = fetch_no404;
      this.endpoint = endpoint;
      this.connection_listeners = {};
      this.ws = null;
      this.connection_id = null;
      this.connection_loop = null;
    }
    async createConnection({ slug }) {
      try {
        let ws_endpoint = this.endpoint.replace("http://", "ws://").replace("https://", "wss://");
        this.ws = new WebSocket(`${ws_endpoint}/api/community/${slug}/live_ws`);
        this.ws.addEventListener("open", (event) => {
          console.log("WebSocket connection opened:", event);
        });
        this.ws.addEventListener("message", async (event) => {
          let data = JSON.parse(event.data);
          console.dir("Received live event", data);
          await this.routeEvent(data);
        });
        this.ws.addEventListener("close", async (event) => {
          console.log("WebSocket connection closed:", event);
          await this.closeConnection({ slug });
        });
      } catch (err) {
        console.error("Error in websocket connection:", err);
        await this.closeConnection({ slug });
      }
    }
    async closeConnection({ slug }) {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      await this.createBackupConnection({ slug });
    }
    async routeEvent(event) {
      let event_type = event;
      let event_value = null;
      if (typeof event !== "string") {
        event_type = Object.keys(event)[0];
        event_value = event[event_type];
      }
      let listeners = this.connection_listeners[event_type] || [];
      for (let callback of listeners) {
        try {
          await callback(event_value);
        } catch (e3) {
          console.error("Error in live event callback:", e3);
        }
      }
    }
    async createBackupConnection({ slug }) {
      let connection_id = await this.fetch(`api/community/${slug}/live`, {
        method: "POST"
      });
      console.dir("Created live connection", connection_id);
      this.connection_id = connection_id;
      if (this.connection_loop) {
        clearInterval(this.connection_loop);
        this.connection_loop = null;
      }
      let failureCount = 0;
      this.connection_loop = setInterval(async () => {
        try {
          let events = await this.fetch_no404(`api/community/${slug}/live/${connection_id}/events`);
          if (events == null) {
            throw new Error("Connection ID not found");
          }
          if (events.length === 0) {
            return;
          }
          console.dir("Fetched live events", connection_id);
          console.dir(events);
          for (let event of events) {
            await this.routeEvent(event);
          }
        } catch (err) {
          console.error("Error fetching live events:", err);
          failureCount++;
          if (failureCount > 5) {
            clearInterval(this.connection_loop);
            this.connection_loop = null;
          }
        }
      }, 5e3);
      return connection_id;
    }
    on(eventType, callback) {
      if (!this.connection_listeners[eventType]) {
        this.connection_listeners[eventType] = [];
      }
      this.connection_listeners[eventType].push(callback);
    }
  };

  // model/TrafficForm.js
  var TrafficForm = class {
    static {
      __name(this, "TrafficForm");
    }
    // every Model has a schema method that returns the schema for the model (if they save local data)
    schema() {
      return {};
    }
    // instantiate is called when the Data system is booted
    instantiate({ db, models, fetch: fetch2, fetch_no404 }) {
      this.db = db;
      this.models = models;
      this.fetch = fetch2;
      this.fetch_no404 = fetch_no404;
    }
    async getForms({ slug }) {
      return this.fetch(`api/community/${slug}/traffic-control-form`);
    }
    async getForm({ slug, formId }) {
      return this.fetch_no404(`api/community/${slug}/traffic-control-form/${formId}`);
    }
    async createOrUpdateForm({ slug, form }) {
      return this.fetch(`api/community/${slug}/traffic-control-form`, {
        method: "POST",
        body: JSON.stringify(form)
      });
    }
    async deleteForm({ slug, formId }) {
      return this.fetch(`api/community/${slug}/traffic-control-form/${formId}`, {
        method: "DELETE"
      });
    }
    async submitForm({ slug, formId }) {
      return this.fetch(`api/community/${slug}/traffic-control-form/${formId}/state`, {
        method: "POST",
        body: JSON.stringify({ state: "submitted" })
      });
    }
    async approveForm({ slug, formId }) {
      return this.fetch(`api/community/${slug}/traffic-control-form/${formId}/state`, {
        method: "POST",
        body: JSON.stringify({ state: "approved" })
      });
    }
  };

  // model/Image.js
  var Image = class {
    static {
      __name(this, "Image");
    }
    // every Model has a schema method that returns the schema for the model (if they save local data)
    schema() {
      return {};
    }
    // instantiate is called when the Data system is booted
    instantiate({ db, models, fetch: fetch2, fetch_no404 }) {
      this.db = db;
      this.models = models;
      this.fetch = fetch2;
      this.fetch_no404 = fetch_no404;
    }
    async uploadBase64Image({ slug, data }) {
      let resp = await this.fetch(`api/community/${slug}/image_base64`, {
        method: "POST",
        body: JSON.stringify({
          image: data
        })
      });
      console.dir(resp);
      return resp;
    }
  };

  // Data.js
  var Data2 = class {
    static {
      __name(this, "Data");
    }
    constructor({ endpoint, options: options2 = {} }) {
      this.endpoint = endpoint;
      console.log("Booting Data System with endpoint", endpoint);
      this.fetch = makeFetchHappen({ endpoint, options: { ...options2 } });
      this.fetch_no404 = makeFetchHappen({ endpoint, options: { ...options2, errorOn404: false } });
      this.local = {};
    }
    async boot() {
      let config = await this.config();
      console.dir("App Config", config);
      this.models = {
        "community": new Community(),
        "verify": new Verify(),
        "session": new Session(),
        "user": new User(),
        "invitecode": new InviteCode(),
        "audit": new Audit(),
        "message": new Message(),
        "live": new Live(),
        "trafficform": new TrafficForm(),
        "image": new Image()
      };
      let schema = {};
      for (let model of Object.values(this.models)) {
        if (!model.schema) {
          continue;
        }
        schema = { ...model.schema(), ...schema };
      }
      console.dir(`Local Database Schema v.${config.version}`, schema);
      this.db = new import_wrapper_default("groovelet");
      this.db.version(config.version).stores(schema);
      for (let model of Object.values(this.models)) {
        if (!model.instantiate) {
          continue;
        }
        model.instantiate({
          db: this.db,
          models: this.models,
          fetch: this.fetch,
          fetch_no404: this.fetch_no404,
          endpoint: this.endpoint
        });
      }
      for (let [name, model] of Object.entries(this.models)) {
        this[name] = model;
        console.log(`Model ${name} attached to Data instance.`);
      }
    }
    semverToInteger(version) {
      let parts = version.split(".").map(Number);
      return parts[0] * 1e4 + parts[1] * 100 + parts[2];
    }
    async config() {
      if (this.local.config) {
        return this.local.config;
      } else {
        console.log("getting config");
        let config = await this.fetch("api/config");
        config.version = this.semverToInteger(config.app_version);
        this.local.config = config;
        return config;
      }
    }
  };

  // bips/Toast/ToastProvider.js
  init_preact_module();
  init_hooks_module();
  init_ToastContext();
  init_htm_module();
  var html8 = htm_module_default.bind(_);
  var ToastProvider = /* @__PURE__ */ __name(({ children }) => {
    const [toasts, setToasts] = d2([]);
    const showToast = q2((message, options2 = {}) => {
      const id = Date.now() + Math.random();
      setToasts((t4) => [...t4, { id, message, options: options2 }]);
    }, []);
    const dismissToast = /* @__PURE__ */ __name((id) => {
      setToasts((t4) => t4.filter((toast) => toast.id !== id));
    }, "dismissToast");
    const getToasts = q2(() => toasts, [toasts]);
    const contextValue = { showToast, dismissToast, getToasts };
    y2(() => {
    }, []);
    return html8`
    <${ToastContext.Provider} value=${contextValue}>
      ${children}
    <//>
  `;
  }, "ToastProvider");
  var ToastProvider_default = ToastProvider;

  // index.js
  var html56 = htm_module_default.bind(_);
  var App = /* @__PURE__ */ __name(() => html56`
  <${LocationProvider}>
    <${ErrorBoundary} onError=${(error) => console.error(error)}>
      <${ToastProvider_default}>
        <div class="app-main">
            <${Router}>
                <${Route} path="/" component=${Home_default} />
                <${Route} path="/home" component=${Home_default} />
                <${Route} path="/home/loading" component=${LoadingPage_default} />
                <${Route} path="/home/about" component=${lazy(() => Promise.resolve().then(() => (init_AboutPage(), AboutPage_exports)))} />
                <${Route} path="/home/bip" component=${lazy(() => Promise.resolve().then(() => (init_BipSamplePage(), BipSamplePage_exports)))} />
                <${Route} path="/home/create" component=${lazy(() => Promise.resolve().then(() => (init_CommunityCreatePage(), CommunityCreatePage_exports)))} />
                <${Route} path="/home/terms" component=${lazy(() => Promise.resolve().then(() => (init_TermsAndConditions(), TermsAndConditions_exports)))} />
                <${Route} path="/home/find" component=${lazy(() => Promise.resolve().then(() => (init_CommunityFindPage(), CommunityFindPage_exports)))} />
                <${Route} path="/community/:slug" component=${lazy(() => Promise.resolve().then(() => (init_CommunityPage(), CommunityPage_exports)))} />
                <${Route} path="/community/:slug/verify" component=${lazy(() => Promise.resolve().then(() => (init_CommunityVerifyPage(), CommunityVerifyPage_exports)))} />
                <${Route} path="/community/:slug/verify/link" component=${lazy(() => Promise.resolve().then(() => (init_CommunityVerifyLinkPage(), CommunityVerifyLinkPage_exports)))} />
                <${Route} path="/community/:slug/login" component=${lazy(() => Promise.resolve().then(() => (init_LoginPage(), LoginPage_exports)))} />
                <${Route} path="/community/:slug/logout" component=${lazy(() => Promise.resolve().then(() => (init_LogoutPage(), LogoutPage_exports)))} />
                <${Route} path="/community/:slug/invite" component=${lazy(() => Promise.resolve().then(() => (init_InviteCodePage(), InviteCodePage_exports)))} />
                <${Route} path="/community/:slug/invite/:id" component=${lazy(() => Promise.resolve().then(() => (init_UserRegistrationPage(), UserRegistrationPage_exports)))} />
                <${Route} path="/community/:slug/users" component=${lazy(() => Promise.resolve().then(() => (init_CommunityUsersPage(), CommunityUsersPage_exports)))} />
                <${Route} path="/community/:slug/users/:userSlug" component=${lazy(() => Promise.resolve().then(() => (init_UserPage(), UserPage_exports)))} />
                <${Route} path="/community/:slug/profile" component=${lazy(() => Promise.resolve().then(() => (init_ProfilePage(), ProfilePage_exports)))} />
                <${Route} path="/community/:slug/audit" component=${lazy(() => Promise.resolve().then(() => (init_CommunityAuditPage(), CommunityAuditPage_exports)))} />
                <${Route} path="/community/:slug/messages" component=${lazy(() => Promise.resolve().then(() => (init_CommunityMessagesPage(), CommunityMessagesPage_exports)))} />
                <${Route} path="/community/:slug/admin" component=${lazy(() => Promise.resolve().then(() => (init_CommunityAdminPage(), CommunityAdminPage_exports)))} />
            <//>
        </div>
      <//>
    <//>
  <//>
  `, "App");
  async function main() {
    let app = document.getElementById("app");
    let endpoint = window.location.origin;
    let data = new Data2({ endpoint, options: { network_simulation: true } });
    await data.boot();
    window.Data = data;
    console.log("Application booted successfully!");
    D(html56`<${App} />`, app);
  }
  __name(main, "main");
  console.log("JS loaded!");
  main();
})();
//# sourceMappingURL=bundle.js.map
