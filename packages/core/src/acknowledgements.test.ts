import { describe, expect, it } from 'vite-plus/test';
import { ACKNOWLEDGEMENTS } from './acknowledgements.ts';
import { thirdPartyNotices } from './thirdPartyNotices.ts';

describe('acknowledgements', () => {
  it('credit every model the apps download, and the copyright line MIT and the OFL keep', () => {
    expect(ACKNOWLEDGEMENTS.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['Parakeet Ultra', 'Parakeet TDT-CTC 110M', 'Qwen3.5 0.8B']),
    );
    for (const entry of ACKNOWLEDGEMENTS) {
      if (entry.licence === 'MIT' || entry.licence === 'OFL-1.1') {
        expect(entry.copyright, entry.name).toBeDefined();
      }
    }
  });

  it('carry each licence’s text once in the notices', () => {
    const notices = thirdPartyNotices();
    for (const title of [
      'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
      'SIL OPEN FONT LICENSE Version 1.1',
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    ]) {
      expect(notices.split(title).length - 1, title).toBe(1);
    }
  });
});
