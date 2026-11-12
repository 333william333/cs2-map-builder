using System;
using System.Collections;
using System.Collections.Generic;

namespace CS2MapBuilder.Systems
{
    /// <summary>
    /// Runs a nested iterator: yielding an IEnumerator runs it to completion first (like Unity coroutines).
    /// </summary>
    public sealed class Coroutine : IDisposable
    {
        private readonly Stack<IEnumerator> m_Stack = new Stack<IEnumerator>();

        public Coroutine(IEnumerator root) { m_Stack.Push(root); }

        /// <summary>Advances one step. Returns false when finished; <paramref name="yielded"/> is the yielded value.</summary>
        public bool MoveNext(out object yielded)
        {
            while (m_Stack.Count > 0)
            {
                var top = m_Stack.Peek();
                if (!top.MoveNext())
                {
                    m_Stack.Pop();
                    (top as IDisposable)?.Dispose();
                    continue;
                }
                var cur = top.Current;
                if (cur is IEnumerator nested)
                {
                    m_Stack.Push(nested);
                    continue;
                }
                yielded = cur;
                return true;
            }
            yielded = null;
            return false;
        }

        public void Dispose()
        {
            while (m_Stack.Count > 0)
            {
                try { (m_Stack.Pop() as IDisposable)?.Dispose(); } catch (Exception) { }
            }
        }
    }
}
