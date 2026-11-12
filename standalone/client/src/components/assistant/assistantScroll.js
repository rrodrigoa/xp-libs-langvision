// Keep refreshes and content resizes from taking control away from a reader.
export function createAssistantScrollFollower(tolerance = 24) {
  let following = true;
  return {
    reset() { following = true; },
    detach() { following = false; },
    onScroll(element) {
      if (element) following = element.scrollHeight - element.clientHeight - element.scrollTop <= tolerance;
    },
    follow(element) {
      if (!element || !following) return false;
      element.scrollTop = element.scrollHeight;
      return true;
    }
  };
}
