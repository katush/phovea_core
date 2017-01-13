
import {defaultSelectionType} from '../idtype/IIDType';
import {IStateToken, StateTokenLeaf, StateTokenNode, TokenType} from './token/StateToken';
import IDType from '../idtype/IDType';
import {EventHandler} from '../event';
import {RandomNumberGenerator} from './internal/RandomNumberGenerator';
import {HashBuilder} from './internal/HashBuilder';

export class SimHash extends EventHandler {

  public static readonly INVALID_CATEGORY:string = 'invalid';
  public static readonly CATEGORIES:string[] = ['data', 'visual', 'selection', 'layout', 'analysis'];
  public static readonly COLORS = ['#e41a1c', '#377eb8', '#984ea3', '#ffff33', '#ff7f00'];

  private static INSTANCE:SimHash = new SimHash(); // === Singleton

  private static readonly NUMBER_OF_BITS:number = 300;
  private static readonly HASH_TABLE_SIZE:number = 1000;

  public static shadeColor(color, percent) {
    /*jshint bitwise:false */
    /*tslint:disable:no-bitwise */
    const f = parseInt(color.slice(1), 16);
    const t = percent < 0 ? 0 : 255;
    const p = percent < 0 ? percent * -1 : percent;
    const R = f >> 16;
    const G = f >> 8 & 0x00FF;
    const B = f & 0x0000FF;
    return '#' + (0x1000000 + (Math.round((t - R) * p) + R) * 0x10000 + (Math.round((t - G) * p) + G) * 0x100 + (Math.round((t - B) * p) + B)).toString(16).slice(1);
    /*jshint bitwise:true */
    /*tslint:enable:no-bitwise */
  }

  public static getCategoryColor(category:string) {
    return SimHash.COLORS[SimHash.CATEGORIES.indexOf(category)];
  }

  /**
   * Uses the singleton pattern
   * @returns {SimHash}
   */
  public static get hasher():SimHash {
    return this.INSTANCE;
  }

  public static normalizeTokenPriority(tokens:IStateToken[], baseLevel:number = 1):IStateToken[] {
    let totalImportance = tokens.reduce((prev, a:IStateToken) => prev + a.importance, 0);
    return tokens.map((t) => {
      t.importance /= totalImportance * baseLevel;
      if (!(t.isLeaf)) {
        (<StateTokenNode>t).childs = this.normalizeTokenPriority((<StateTokenNode>t).childs, t.importance);
      }
      return t;
    });
  }

  private static groupBy(arr:StateTokenLeaf[], property:string) {
    return arr.reduce((prev, curr:StateTokenLeaf) => {
      let val = curr[property];
      if (!prev[val]) {
        prev[val] = [];
      }
      prev[val].push(curr);
      return prev;
    }, []);
  }

  private static prepHashCalc(tokens:StateTokenLeaf[], needsNormalization:boolean = true) {
    if (needsNormalization && tokens !== undefined) {
      let totalImportance = tokens.reduce((prev, a:IStateToken) => prev + a.importance, 0);
      tokens = tokens.map((t) => {
        t.importance /= totalImportance;
        return t;
      });
    }
    return SimHash.groupBy(tokens, 'type');
  }

  private static filterLeafsAndSerialize(tokens:IStateToken[]):StateTokenLeaf[] {
    let childs:StateTokenLeaf[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].isLeaf) {
        childs = childs.concat(<StateTokenLeaf>tokens[i]);
      } else {
        childs = childs.concat(
          this.filterLeafsAndSerialize((<StateTokenNode>tokens[i]).childs)
        );
      }
    }
    return childs;
  }

  private readonly hashBuilder:HashBuilder[] = [];

  private _catWeighting:number[] = [30, 20, 25, 20, 5];

  get categoryWeighting() {
    return this._catWeighting;
  }

  set categoryWeighting(weighting) {
    this._catWeighting = weighting;
    //this.fire('weighting_change');
  }

  public getHashOfIDTypeSelection(token:StateTokenLeaf, selectionType):string {
    let type:IDType = (<IDType>token.value); // TODO ensure that value contains an IDType

    if (this.hashBuilder[type.id] === undefined) {
      this.hashBuilder[type.id] = new HashBuilder(SimHash.HASH_TABLE_SIZE);
    }

    type.selections(selectionType).dim(0).asList(0) // array of selected ids
      .map((sel) => {
        return new StateTokenLeaf(
          'dummy',
          1,
          TokenType.string,
          sel.toString()
        );
      })
      .forEach((t) => {
        return this.hashBuilder[type.id].push(t.value, t.value, t.importance, null);
      });

    token.hash = this.hashBuilder[type.id].toHash(SimHash.NUMBER_OF_BITS);
    return token.hash;
  }

  public getHashOfOrdinalIDTypeSelection(type:IDType, min:number, max:number, selectionType):string {
    if (this.hashBuilder[type.id] === undefined) {
      this.hashBuilder[type.id] = new HashBuilder(SimHash.HASH_TABLE_SIZE);
    }

    type.selections(selectionType).dim(0).asList(0) // array of selected ids
      .forEach((sel) => {
        this.hashBuilder[type.id].push(
          String(sel),
          String(sel),
          1,
          ordinalHash(min, max, sel, SimHash.NUMBER_OF_BITS)
        );
      });

    return this.hashBuilder[type.id].toHash(SimHash.NUMBER_OF_BITS);
  }

  public calcHash(tokens:IStateToken[]):string[] {
    if (tokens.length === 0) {
      return SimHash.CATEGORIES.map(() => SimHash.INVALID_CATEGORY);
    }
    tokens = SimHash.normalizeTokenPriority(tokens, 1);
    let leafs:StateTokenLeaf[] = SimHash.filterLeafsAndSerialize(tokens);
    let groupedTokens = SimHash.groupBy(leafs, 'category');
    return SimHash.CATEGORIES.map((cat) => this.calcHashOfCat(groupedTokens[cat], cat));
  }

  private calcHashOfCat(tokens:StateTokenLeaf[], cat:string) {
    if (tokens === undefined) {
      return Array(SimHash.NUMBER_OF_BITS + 1).join('0');
    }

    if (this.hashBuilder[cat] === undefined) {
      this.hashBuilder[cat] = new HashBuilder(SimHash.HASH_TABLE_SIZE);
    }

    SimHash.prepHashCalc(tokens)
      .forEach((tokenLeafs, index) => {
        this.pushHashBuilder(this.hashBuilder[cat], tokenLeafs, index);
      });

    return this.hashBuilder[cat].toHash(SimHash.NUMBER_OF_BITS);
  };

  private pushHashBuilder(hashBuilder:HashBuilder, tokenLeaves:StateTokenLeaf[], index:number) {
    if(!tokenLeaves) {
      return;
    }

    let hashingFnc;

    switch(index) {
      case 0: // regular tokens
        hashingFnc = (t) => null;
        break;
      case 1: // ordinal tokens
        hashingFnc = (t) => (t) => ordinalHash(t.value[0], t.value[1], t.value[2], SimHash.NUMBER_OF_BITS);
        break;
      case 2: // ordinal idType tokens
        hashingFnc = (t) => this.getHashOfOrdinalIDTypeSelection(t.value[0], t.value[1], t.value[2], defaultSelectionType);
        break;
      case 3: // idtype tokens
        hashingFnc = (t) => this.getHashOfIDTypeSelection(t, defaultSelectionType);
        break;
    }

    tokenLeaves.forEach((t) => {
      hashBuilder.push(t.name, <string>t.value, t.importance, hashingFnc(t));
    });
  };

}

/**
 * Calculate a 32 bit FNV-1a hash
 * Found here: https://gist.github.com/vaiorabbit/5657561
 * Ref.: http://isthe.com/chongo/tech/comp/fnv/
 *
 * @param {string} str the input value
 * @param {number} [seed] optionally pass the hash of the previous chunk
 * @returns {string}
 */
function hashFnv32a(str:string, seed:number):string {
  /*jshint bitwise:false */
  /*tslint:disable:no-bitwise */
  let hval = (typeof seed !== 'undefined') ? 0x811c9dc5 : seed;
  for (let i = 0, l = str.length; i < l; i++) {
    hval ^= str.charCodeAt(i);
    hval += (hval << 1) + (hval << 4) + (hval << 7) + (hval << 8) + (hval << 24);
  }
  return (hval >>> 0).toString(2);
  /*tslint:enable:no-bitwise */
  /*jshint bitwise:true */
}


function ordinalHash(min:number, max:number, value:number, nrBits:number):string {
  let pct = (value - min) / (max - min);
  let minH:string = hashFnv32a(String(min), 0);
  let maxH:string = hashFnv32a(String(max), 0);
  let rng = new RandomNumberGenerator(1);

  let hash:string = '';
  for (let i = 0; i < nrBits; i++) {
    if (rng.nextDouble() > pct) {
      hash = hash + minH.charAt(i % minH.length);
    } else {
      hash = hash + maxH.charAt(i % maxH.length);
    }
  }
  return hash;
}

/*function dec2bin(dec:number):string {
  return (dec >>> 0).toString(2);
}*/
